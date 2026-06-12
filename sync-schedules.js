const { Pool } = require('pg');

const localUrl = process.env.LOCAL_DATABASE_URL || 'postgresql://postgres@localhost:5432/walknorth';
const renderUrl = process.env.RENDER_DATABASE_URL;

if (!renderUrl) {
  console.error('Set RENDER_DATABASE_URL');
  process.exit(1);
}

const localPool = new Pool({ connectionString: localUrl });
const renderPool = new Pool({
  connectionString: renderUrl,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const local = await localPool.connect();
  const render = await renderPool.connect();

  try {
    const localRows = await local.query(
      `SELECT tour, datetime_start, datetime_end
       FROM tours_schedule
       WHERE datetime_start::date >= CURRENT_DATE
       ORDER BY tour, datetime_start`
    );

    const bookedRes = await render.query(
      `SELECT DISTINCT tour_schedule
       FROM bookings
       WHERE tour_schedule IS NOT NULL`
    );
    const bookedIds = bookedRes.rows.map(r => r.tour_schedule);

    await render.query('BEGIN');

    let deleted = 0;
    if (bookedIds.length > 0) {
      const del = await render.query(
        `DELETE FROM tours_schedule
         WHERE id_tour_schedule NOT IN (${bookedIds.map((_, i) => `$${i + 1}`).join(',')})`,
        bookedIds
      );
      deleted = del.rowCount;
    } else {
      const del = await render.query('DELETE FROM tours_schedule');
      deleted = del.rowCount;
    }

    let inserted = 0;
    for (const row of localRows.rows) {
      const ins = await render.query(
        `INSERT INTO tours_schedule (tour, datetime_start, datetime_end)
         SELECT $1, $2, $3
         WHERE NOT EXISTS (
           SELECT 1 FROM tours_schedule
           WHERE tour = $1 AND datetime_start = $2
         )`,
        [row.tour, row.datetime_start, row.datetime_end]
      );
      inserted += ins.rowCount;
    }

    await render.query(
      `SELECT setval(
         'tour_slots_id_slot_seq',
         COALESCE((SELECT MAX(id_tour_schedule) FROM tours_schedule), 1),
         true
       )`
    );

    await render.query('COMMIT');

    const countRes = await render.query(
      `SELECT tour, COUNT(*)::int AS cnt
       FROM tours_schedule
       WHERE datetime_start::date >= CURRENT_DATE
       GROUP BY tour
       ORDER BY tour`
    );

    console.log(`Deleted on Render: ${deleted}`);
    console.log(`Inserted from local: ${inserted}`);
    console.log('Future schedules per tour on Render:');
    for (const row of countRes.rows) {
      console.log(`  tour ${row.tour}: ${row.cnt}`);
    }
  } catch (err) {
    await render.query('ROLLBACK');
    throw err;
  } finally {
    local.release();
    render.release();
    await localPool.end();
    await renderPool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
