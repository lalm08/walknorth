const express = require('express');
const { Pool } = require('pg');
const sharp = require('sharp'); 
const app = express();
const PORT = process.env.PORT || 3000;
const axios = require('axios');

app.use(express.json());

// Подключение к БД
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const formatRows = async (rows, width = 300) => {
  return await Promise.all(rows.map(async (row) => {
    const newRow = { ...row };
    for (let key in newRow) {
      if (Buffer.isBuffer(newRow[key])) {
        try {
          let pipeline = sharp(newRow[key])
            .resize(width, null, {
              fit: 'inside',     
              withoutEnlargement: true 
            });

          if (width <= 200) {
            const buffer = await pipeline.png().toBuffer();
            newRow[key] = buffer.toString('base64');
          } else {
            const buffer = await pipeline.webp({ quality: 70 }).toBuffer();
            newRow[key] = buffer.toString('base64');
          }
        } catch (e) {
          console.error("Ошибка обработки изображения:", e);
          newRow[key] = null; 
        }
      }
    }
    return newRow;
  }));
};

async function getRoutePoints(routeId) {
  const queries = [
    `SELECT ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lon, p.name_place
     FROM places p
     JOIN place_and_route par ON p.id_place = par.place_id
     WHERE par.route_id = $1
     ORDER BY par.order_number`,
    `SELECT ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lon, p.name_place
     FROM places p
     JOIN place_and_route par ON p.id_place = par.place_id
     WHERE par.route_id = $1
     ORDER BY p.name_place`
  ];
  for (const sql of queries) {
    try {
      return (await pool.query(sql, [routeId])).rows;
    } catch (e) {
      console.warn('Route points query failed:', e.message);
    }
  }
  return [];
}

async function getTourPlaces(tourId) {
  const joinVariants = [
    'JOIN route_and_tour rat ON t.id_tour = rat.tour_id',
    'JOIN route_and_tour rat ON t.id_tour = rat.tour'
  ];
  for (const joinRat of joinVariants) {
    const queries = [
      `SELECT p.id_place, p.name_place, MIN(par.order_number) AS ord
       FROM tours t
       ${joinRat}
       JOIN routes r ON rat.route_id = r.id_route
       JOIN place_and_route par ON r.id_route = par.route_id
       JOIN places p ON par.place_id = p.id_place
       WHERE t.id_tour = $1
       GROUP BY p.id_place, p.name_place
       ORDER BY ord, p.name_place`,
      `SELECT DISTINCT p.id_place, p.name_place
       FROM tours t
       ${joinRat}
       JOIN routes r ON rat.route_id = r.id_route
       JOIN place_and_route par ON r.id_route = par.route_id
       JOIN places p ON par.place_id = p.id_place
       WHERE t.id_tour = $1
       ORDER BY p.name_place`
    ];
    for (const sql of queries) {
      try {
        const rows = (await pool.query(sql, [tourId])).rows;
        if (rows.length > 0) return rows;
      } catch (e) {
        console.warn('Tour places query failed:', e.message);
      }
    }
  }
  return [];
}

async function getOrsLegPath(start, end, profile) {
  const coords = [
    [parseFloat(start.lon), parseFloat(start.lat)],
    [parseFloat(end.lon), parseFloat(end.lat)]
  ];
  if (!process.env.ORS_API_KEY) return [];
  try {
    const orsResponse = await axios.post(
      `https://api.openrouteservice.org/v2/directions/${profile}/geojson`,
      { coordinates: coords, language: 'ru', preference: 'shortest' },
      {
        headers: {
          Authorization: process.env.ORS_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );
    return orsResponse.data.features[0].geometry.coordinates.map(c => ({ lat: c[1], lon: c[0] }));
  } catch (e) {
    console.warn('ORS leg routing failed:', e.response?.data || e.message);
    return [];
  }
}

async function getOsrmLegPath(start, end, profile) {
  const osrmProfile = profile.includes('foot') ? 'foot' : 'driving';
  const lon1 = parseFloat(start.lon);
  const lat1 = parseFloat(start.lat);
  const lon2 = parseFloat(end.lon);
  const lat2 = parseFloat(end.lat);
  const url = `https://router.project-osrm.org/route/v1/${osrmProfile}/${lon1},${lat1};${lon2},${lat2}?overview=full&geometries=geojson`;
  try {
    const res = await axios.get(url, { timeout: 20000 });
    if (res.data.code !== 'Ok' || !res.data.routes?.[0]?.geometry?.coordinates) return [];
    return res.data.routes[0].geometry.coordinates.map(c => ({ lat: c[1], lon: c[0] }));
  } catch (e) {
    console.warn('OSRM leg routing failed:', e.message);
    return [];
  }
}

async function getRoadPath(points, profile = 'driving-car') {
  if (!points || points.length === 0) return [];
  if (points.length === 1) {
    return [{ lat: parseFloat(points[0].lat), lon: parseFloat(points[0].lon) }];
  }

  const merged = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    let leg = await getOrsLegPath(start, end, profile);
    if (leg.length < 2) {
      leg = await getOsrmLegPath(start, end, profile);
    }
    if (leg.length < 2) {
      leg = [
        { lat: parseFloat(start.lat), lon: parseFloat(start.lon) },
        { lat: parseFloat(end.lat), lon: parseFloat(end.lon) }
      ];
    }
    if (merged.length > 0) leg.shift();
    merged.push(...leg);
  }
  return merged;
}

async function getOrsPath(points, profile) {
  return getRoadPath(points, profile);
}

async function getRoutePathFromDb(routeId) {
  try {
    const res = await pool.query(
      `SELECT ST_AsGeoJSON(r.route_path) AS geojson FROM routes r WHERE r.id_route = $1`,
      [routeId]
    );
    if (res.rows[0]?.geojson) {
      const geo = JSON.parse(res.rows[0].geojson);
      if (geo.type === 'LineString') {
        return geo.coordinates.map(c => ({ lat: c[1], lon: c[0] }));
      }
      if (geo.type === 'MultiLineString') {
        return geo.coordinates.flat().map(c => ({ lat: c[1], lon: c[0] }));
      }
    }
  } catch (e) {
    console.warn('Route path unavailable:', e.message);
  }
  return [];
}

function normalizeScheduleRows(rows) {
  return rows.map(r => ({
    id: r.id_tour_schedule ?? r.id_schedule ?? r.schedule_id ?? r.id,
    id_tour_schedule: r.id_tour_schedule ?? r.id_schedule ?? r.schedule_id ?? r.id,
    datetime_start: r.datetime_start ?? r.date_start ?? r.start_date ?? r.start_time ?? r.datetime,
    datetime_end: r.datetime_end ?? r.date_end ?? r.end_date ?? r.end_time
  })).filter(r => r.id != null && r.datetime_start != null);
}

let scheduleMetaCache = null;

async function getScheduleTableMeta() {
  if (scheduleMetaCache) return scheduleMetaCache;
  const tableNames = ['tours_schedule', 'tour_schedule'];
  for (const table of tableNames) {
    try {
      const { rows } = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table]
      );
      if (rows.length === 0) continue;
      const names = rows.map(c => c.column_name);
      const tourCol = ['tour', 'tour_id', 'id_tour', 'fk_tour', 'id_tours'].find(c => names.includes(c));
      const startCol = ['datetime_start', 'date_start', 'start_date', 'start_time', 'datetime']
        .find(c => names.includes(c));
      const endCol = ['datetime_end', 'date_end', 'end_date', 'end_time'].find(c => names.includes(c));
      const idCol = ['id_tour_schedule', 'id_schedule', 'schedule_id'].find(c => names.includes(c))
        || (names.includes('id') ? 'id' : null);
      if (tourCol && startCol && idCol) {
        scheduleMetaCache = { table, tourCol, startCol, endCol, idCol };
        return scheduleMetaCache;
      }
    } catch (e) {
      console.warn('Schedule meta detection failed:', e.message);
    }
  }
  return null;
}

function isFutureSchedule(row) {
  if (!row.datetime_start) return false;
  const start = new Date(row.datetime_start);
  if (Number.isNaN(start.getTime())) return true;
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return startDay >= today;
}

async function queryTourSchedule(tourId) {
  const tid = Number(tourId);
  const meta = await getScheduleTableMeta();
  if (!meta) return [];

  const endSelect = meta.endCol || meta.startCol;
  const selectSql = `${meta.idCol} AS id_tour_schedule, ${meta.startCol} AS datetime_start, ${endSelect} AS datetime_end`;

  const queries = [
    `SELECT ${selectSql} FROM ${meta.table} WHERE ${meta.tourCol} = $1 ORDER BY ${meta.startCol}`,
    `SELECT ${selectSql} FROM ${meta.table} WHERE CAST(${meta.tourCol} AS TEXT) = $1 ORDER BY ${meta.startCol}`,
    `SELECT ts.${meta.idCol} AS id_tour_schedule, ts.${meta.startCol} AS datetime_start, ts.${endSelect} AS datetime_end
     FROM ${meta.table} ts
     INNER JOIN tours t ON ts.${meta.tourCol} = t.id_tour
     WHERE t.id_tour = $1
     ORDER BY ts.${meta.startCol}`
  ];

  const byId = new Map();

  const addRows = (rows, onlyFuture) => {
    for (const row of normalizeScheduleRows(rows)) {
      if (onlyFuture && !isFutureSchedule(row)) continue;
      byId.set(String(row.id_tour_schedule), row);
    }
  };

  for (const sql of queries) {
    try {
      addRows((await pool.query(sql, [tid])).rows, false);
    } catch (e) {
      console.warn('Schedule query failed:', e.message);
    }
  }

  let result = Array.from(byId.values()).sort(
    (a, b) => new Date(a.datetime_start) - new Date(b.datetime_start)
  );

  const future = result.filter(isFutureSchedule);
  if (future.length > 0) {
    return future;
  }

  return result;
}

async function seedDefaultSchedules(tourId) {
  const offsets = [7, 14, 21, 28];
  const tableNames = ['tours_schedule', 'tour_schedule'];

  for (const table of tableNames) {
    try {
      const { rows: columns } = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table]
      );
      if (columns.length === 0) continue;

      const names = columns.map(c => c.column_name);
      const tourCol = ['tour_id', 'tour', 'id_tour'].find(c => names.includes(c));
      const startCol = ['datetime_start', 'date_start', 'start_date', 'start_time', 'datetime'].find(c => names.includes(c));
      const endCol = ['datetime_end', 'date_end', 'end_date', 'end_time'].find(c => names.includes(c));
      const idCol = ['id_tour_schedule', 'id_schedule', 'schedule_id', 'id'].find(c => names.includes(c));
      if (!tourCol || !startCol) continue;

      const endColSql = endCol || startCol;
      const created = [];

      for (const days of offsets) {
        const start = new Date();
        start.setDate(start.getDate() + days);
        start.setHours(10, 0, 0, 0);
        const end = new Date(start);
        end.setHours(18, 0, 0, 0);

        const sql = `INSERT INTO ${table} (${tourCol}, ${startCol}, ${endColSql})
                     VALUES ($1, $2, $3)
                     RETURNING *`;
        try {
          const result = await pool.query(sql, [tourId, start, end]);
          if (result.rows[0]) created.push(result.rows[0]);
        } catch (e) {
          console.warn('Schedule seed insert failed:', e.message);
        }
      }

      if (created.length > 0) {
        console.log(`Seeded ${created.length} schedules for tour ${tourId} in ${table}`);
        return normalizeScheduleRows(created);
      }
    } catch (e) {
      console.warn('Schedule seed failed:', e.message);
    }
  }

  return [];
}

app.get('/api/main-data', async (req, res) => {
  const { cityName } = req.query;
  const searchCity = cityName || 'Сыктывкар'; 

  try {
    const districtsPromise = pool.query('SELECT id_district, name_district, photo_binary FROM districts ORDER BY name_district');
    
    const nearbySql = `
      SELECT * FROM (
        SELECT DISTINCT ON (p.id_place) p.id_place, p.name_place, ph.photo_binary 
        FROM places p 
        JOIN photos ph ON p.id_place = ph.place_id 
        JOIN districts d ON p.district_id = d.id_district 
        WHERE d.name_district ILIKE $1
      ) as subquery
      ORDER BY RANDOM() 
      LIMIT 5`;
      
    const nearbyPromise = pool.query(nearbySql, [`%${searchCity}%`]);
    const pickedPromise = pool.query(
      `SELECT id_tour, name_tour, price FROM tours ORDER BY RANDOM() LIMIT 5`
    );
    const [districtsRes, nearbyRes, pickedRes] = await Promise.all([
      districtsPromise, nearbyPromise, pickedPromise
    ]);
    const compressedDistricts = await formatRows(districtsRes.rows, 150);
    const compressedNearby = await formatRows(nearbyRes.rows, 350);

    res.json({
      districts: compressedDistricts,
      nearby: compressedNearby,
      pickedTours: pickedRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/districts', async (req, res) => {
  try {
    const result = await pool.query('SELECT id_district, name_district FROM districts ORDER BY name_district');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/district-details/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT name_district, description, photo_binary FROM districts WHERE id_district = $1',
      [req.params.id]
    );
    const row = result.rows[0];
    let images = [];
    if (row?.photo_binary) {
      const formatted = await formatRows([{ photo_binary: row.photo_binary }], 800);
      images = formatted.map(p => p.photo_binary).filter(Boolean);
    }

    res.json({
      name: row?.name_district || '',
      description: row?.description || '',
      images
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


//туры по району 
app.get('/api/tours', async (req, res) => {
  const { districtId } = req.query;
  try {
    const sql = `SELECT DISTINCT t.id_tour, t.name_tour, t.price 
                 FROM tours t JOIN route_and_tour rat ON t.id_tour = rat.tour_id
                 JOIN routes r ON rat.route_id = r.id_route
                 JOIN place_and_route par ON r.id_route = par.route_id
                 JOIN places p ON par.place_id = p.id_place
                 WHERE p.district_id = $1
                 ORDER BY t.name_tour`;
    const result = await pool.query(sql, [districtId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// детали тура: описание, места, отзывы, избранное
app.get('/api/tour-details/:id', async (req, res) => {
  const tourId = req.params.id;
  const userId = req.query.userId;

  try {
    const tourRes = await pool.query(
      'SELECT id_tour, name_tour, description, price FROM tours WHERE id_tour = $1',
      [tourId]
    );
    if (tourRes.rows.length === 0) {
      return res.status(404).json({ error: 'Тур не найден' });
    }

    let placesRows = [];
    try {
      placesRows = await getTourPlaces(tourId);
    } catch (placesErr) {
      console.warn('Tour places unavailable:', placesErr.message);
    }

    let reviews = [];
    let avgRating = 0;
    try {
      const reviewsRes = await pool.query(
        `SELECT u.fio AS user_name, rev.rating, rev.text_review AS text
         FROM reviews rev
         JOIN users u ON rev.user_id = u.id_user
         WHERE rev.tour_id = $1
         ORDER BY rev.id_review DESC`,
        [tourId]
      );
      reviews = reviewsRes.rows;
      if (reviews.length > 0) {
        avgRating = reviews.reduce((sum, r) => sum + Number(r.rating), 0) / reviews.length;
        avgRating = Math.round(avgRating * 10) / 10;
      }
    } catch (reviewErr) {
      console.warn('Reviews unavailable:', reviewErr.message);
    }

    let isFavorite = false;
    if (userId && userId !== '-1') {
      const favRes = await pool.query(
        'SELECT id_favorite FROM favorites WHERE user_id = $1 AND tour_id = $2',
        [userId, tourId]
      );
      isFavorite = favRes.rows.length > 0;
    }

    const tour = tourRes.rows[0];
    res.json({
      id: tour.id_tour,
      name: tour.name_tour,
      description: tour.description,
      price: tour.price,
      places: placesRows.map(p => ({ id: p.id_place, name: p.name_place })),
      reviews,
      avgRating,
      isFavorite
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/favorites/toggle', async (req, res) => {
  const { userId, tourId } = req.body;
  if (!userId || userId === -1 || !tourId) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  try {
    const existing = await pool.query(
      'SELECT id_favorite FROM favorites WHERE user_id = $1 AND tour_id = $2',
      [userId, tourId]
    );
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM favorites WHERE user_id = $1 AND tour_id = $2', [userId, tourId]);
      return res.json({ success: true, isFavorite: false });
    }
    await pool.query('INSERT INTO favorites (user_id, tour_id) VALUES ($1, $2)', [userId, tourId]);
    res.json({ success: true, isFavorite: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/favorites/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id_tour AS id, t.name_tour AS name, t.price
       FROM favorites f
       JOIN tours t ON f.tour_id = t.id_tour
       WHERE f.user_id = $1
       ORDER BY t.name_tour`,
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tour-map/:tourId', async (req, res) => {
  const tourId = parseInt(req.params.tourId, 10);
  const routeQueries = [
    `SELECT r.id_route
     FROM route_and_tour rat
     JOIN routes r ON rat.route_id = r.id_route
     WHERE rat.tour_id = $1
     ORDER BY r.id_route`,
    `SELECT r.id_route
     FROM route_and_tour rat
     JOIN routes r ON rat.route_id = r.id_route
     WHERE rat.tour = $1
     ORDER BY r.id_route`
  ];
  try {
    let routeIds = [];
    for (const sql of routeQueries) {
      try {
        const routesRes = await pool.query(sql, [tourId]);
        if (routesRes.rows.length > 0) {
          routeIds = routesRes.rows.map(r => r.id_route);
          break;
        }
      } catch (e) {
        console.warn('Tour routes query failed:', e.message);
      }
    }
    const isRiverTour = routeIds.length >= 2;
    const segments = [];

    if (routeIds.length >= 2) {
      const carPoints = await getRoutePoints(routeIds[0]);
      const boatPoints = await getRoutePoints(routeIds[1]);
      const boatPath = boatPoints.map(p => ({ lat: parseFloat(p.lat), lon: parseFloat(p.lon) }));
      segments.push({
        type: 'car',
        label: 'Дорога на машине',
        points: carPoints,
        path: await getRoadPath(carPoints, 'driving-car')
      });
      segments.push({
        type: 'boat',
        label: 'Участок без дороги',
        points: boatPoints,
        path: boatPath
      });
    } else if (routeIds.length > 0) {
      const points = await getRoutePoints(routeIds[0]);
      segments.push({
        type: 'car',
        label: 'Маршрут на машине',
        points,
        path: await getRoadPath(points, 'driving-car')
      });
    }

    res.json({ isRiverTour, segments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tour-schedule/:tourId', async (req, res) => {
  try {
    let rows = await queryTourSchedule(req.params.tourId);
    if (rows.length === 0) {
      rows = await seedDefaultSchedules(req.params.tourId);
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function normalizeScheduleKey(datetimeStart) {
  if (!datetimeStart) return '';
  const d = new Date(datetimeStart);
  if (Number.isNaN(d.getTime())) return String(datetimeStart).substring(0, 16);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatPriceValue(price) {
  if (price == null) return '0 ₽';
  const num = Number(String(price).replace(',', '.'));
  if (Number.isNaN(num)) return String(price);
  if (Number.isInteger(num)) return `${num} ₽`;
  return `${num.toFixed(2).replace(/\.?0+$/, '')} ₽`;
}

function groupClientBookings(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.name_tour}|${normalizeScheduleKey(row.datetime_start)}`;
    if (map.has(key)) {
      const existing = map.get(key);
      existing.count_people = (existing.count_people || 1) + (row.count_people || 1);
    } else {
      map.set(key, {
        id_booking: row.id_booking,
        id_tour: row.id_tour,
        name_tour: row.name_tour,
        price: formatPriceValue(row.price),
        datetime_start: row.datetime_start,
        datetime_end: row.datetime_end,
        count_people: row.count_people || 1,
        can_cancel: isFutureSchedule({ datetime_start: row.datetime_start })
      });
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => new Date(b.datetime_start) - new Date(a.datetime_start)
  );
}

function groupGuideBookings(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.name_tour}|${normalizeScheduleKey(row.datetime_start)}`;
    if (map.has(key)) {
      const existing = map.get(key);
      existing.count_people = (existing.count_people || 1) + (row.count_people || 1);
    } else {
      map.set(key, {
        id_booking: row.id_booking,
        id_tour: row.id_tour,
        name_tour: row.name_tour,
        datetime_start: row.datetime_start,
        count_people: row.count_people || 1,
        client_name: row.client_name || 'Клиент'
      });
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => new Date(b.datetime_start) - new Date(a.datetime_start)
  );
}

async function scheduleBelongsToTour(scheduleId, tourId) {
  if (!tourId) return true;
  const meta = await getScheduleTableMeta();
  if (!meta) return true;
  const endSelect = meta.endCol || meta.startCol;
  const selectSql = `${meta.idCol} AS id_tour_schedule, ${meta.tourCol} AS tour_ref`;
  const queries = [
    `SELECT ${selectSql} FROM ${meta.table} WHERE ${meta.idCol} = $1 AND ${meta.tourCol} = $2`,
    `SELECT ${selectSql} FROM ${meta.table} WHERE ${meta.idCol} = $1 AND CAST(${meta.tourCol} AS TEXT) = $2`
  ];
  for (const sql of queries) {
    try {
      const { rows } = await pool.query(sql, [scheduleId, tourId]);
      if (rows.length > 0) return true;
    } catch (e) {
      console.warn('Schedule tour check failed:', e.message);
    }
  }
  return false;
}

app.post('/api/bookings', async (req, res) => {
  const { userId, scheduleId, countPeople, tourId } = req.body;
  if (!userId || userId === -1 || !scheduleId) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  try {
    if (tourId && !(await scheduleBelongsToTour(scheduleId, tourId))) {
      return res.status(400).json({ error: 'Выбранная дата не относится к этому туру' });
    }

    const schedule = await pool.query(
      `SELECT id_tour_schedule FROM tours_schedule
       WHERE id_tour_schedule = $1 AND datetime_start::date >= CURRENT_DATE`,
      [scheduleId]
    );
    if (schedule.rows.length === 0) {
      return res.status(400).json({ error: 'Дата недоступна для бронирования' });
    }

    const insertQueries = [
      `INSERT INTO bookings (user_id, tour_schedule, status_booking, date_booking, count_people)
       VALUES ($1, $2, 1, CURRENT_TIMESTAMP, $3) RETURNING id_booking`,
      `INSERT INTO bookings (user_id, tour_schedule_id, status_booking, date_booking, count_people)
       VALUES ($1, $2, 1, CURRENT_TIMESTAMP, $3) RETURNING id_booking`
    ];

    let bookingId = null;
    for (const sql of insertQueries) {
      try {
        const result = await pool.query(sql, [userId, scheduleId, countPeople || 1]);
        bookingId = result.rows[0].id_booking;
        break;
      } catch (e) {
        console.warn('Booking insert failed:', e.message);
      }
    }

    if (!bookingId) {
      return res.status(500).json({ error: 'Не удалось создать бронирование' });
    }

    try {
      const tourInfoVariants = [
        `SELECT t.id_tour, t.name_tour
         FROM tours_schedule ts
         JOIN tours t ON ts.tour = t.id_tour
         WHERE ts.id_tour_schedule = $1`,
        `SELECT t.id_tour, t.name_tour
         FROM tours_schedule ts
         JOIN tours t ON ts.tour_id = t.id_tour
         WHERE ts.id_tour_schedule = $1`
      ];
      for (const sql of tourInfoVariants) {
        try {
          const tourInfo = await pool.query(sql, [scheduleId]);
          if (tourInfo.rows.length > 0) {
            const { id_tour, name_tour } = tourInfo.rows[0];
            const guideUserId = await resolveGuideUserIdForTour(id_tour);
            if (guideUserId) {
              await ensureTourChat(userId, guideUserId, name_tour);
            }
            break;
          }
        } catch (e) {
          console.warn('Tour chat after booking failed:', e.message);
        }
      }
    } catch (e) {
      console.warn('Tour chat sync after booking failed:', e.message);
    }

    res.json({ success: true, bookingId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bookings/cancel', async (req, res) => {
  const { userId, id_booking } = req.body;
  if (!userId || userId === -1 || !id_booking) {
    return res.status(400).json({ error: 'userId и id_booking обязательны' });
  }
  try {
    const bookingVariants = [
      {
        join: 'JOIN tours_schedule ts ON b.tour_schedule = ts.id_tour_schedule',
        tourJoin: 'JOIN tours t ON ts.tour = t.id_tour'
      },
      {
        join: 'JOIN tours_schedule ts ON b.tour_schedule = ts.id_tour_schedule',
        tourJoin: 'JOIN tours t ON ts.tour_id = t.id_tour'
      }
    ];

    let bookingRow = null;
    for (const variant of bookingVariants) {
      try {
        const { rows } = await pool.query(
          `SELECT b.id_booking, b.user_id, b.tour_schedule, ts.datetime_start
           FROM bookings b
           ${variant.join}
           WHERE b.id_booking = $1 AND b.user_id = $2`,
          [id_booking, userId]
        );
        if (rows.length > 0) {
          bookingRow = rows[0];
          break;
        }
      } catch (e) {
        console.warn('Cancel booking lookup failed:', e.message);
      }
    }

    if (!bookingRow) {
      return res.status(404).json({ error: 'Бронирование не найдено' });
    }
    if (!isFutureSchedule({ datetime_start: bookingRow.datetime_start })) {
      return res.status(400).json({ error: 'Нельзя отменить прошедшее бронирование' });
    }

    await pool.query(
      'DELETE FROM bookings WHERE user_id = $1 AND tour_schedule = $2',
      [userId, bookingRow.tour_schedule]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bookings/:userId', async (req, res) => {
  const variants = [
    {
      join: 'JOIN tours t ON ts.tour = t.id_tour',
      scheduleCol: 'b.tour_schedule = ts.id_tour_schedule'
    },
    {
      join: 'JOIN tours t ON ts.tour_id = t.id_tour',
      scheduleCol: 'b.tour_schedule = ts.id_tour_schedule'
    },
    {
      join: 'JOIN tours t ON ts.tour_id = t.id_tour',
      scheduleCol: 'b.tour_schedule_id = ts.id_tour_schedule'
    }
  ];
  try {
    for (const variant of variants) {
      try {
        const result = await pool.query(
          `SELECT b.id_booking, t.id_tour, t.name_tour, t.price,
                  ts.datetime_start, ts.datetime_end, b.count_people, b.date_booking
           FROM bookings b
           JOIN tours_schedule ts ON ${variant.scheduleCol}
           ${variant.join}
           WHERE b.user_id = $1
           ORDER BY ts.datetime_start DESC`,
          [req.params.userId]
        );
        return res.json(groupClientBookings(result.rows));
      } catch (e) {
        console.warn('Bookings query failed:', e.message);
      }
    }
    res.json([]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

//детали места 
app.get('/api/place-details/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const { rows: columns } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'places'`
    );
    const names = columns.map(c => c.column_name);
    const nameCol = ['name_place', 'name', 'place_name'].find(c => names.includes(c)) || 'name_place';
    const descCol = ['description', 'description_place', 'text', 'about'].find(c => names.includes(c));
    const hasLocation = names.includes('location');

    let infoRow = null;
    if (hasLocation) {
      const descSelect = descCol ? `p.${descCol}` : "''";
      const sql = `SELECT p.${nameCol} AS name_place,
                          ${descSelect} AS description,
                          ST_Y(p.location::geometry) AS lat,
                          ST_X(p.location::geometry) AS lon
                   FROM places p
                   WHERE p.id_place = $1`;
      try {
        const result = await pool.query(sql, [id]);
        infoRow = result.rows[0] || null;
      } catch (e) {
        console.warn('Place info query failed:', e.message);
      }
    }

    if (!infoRow) {
      const fallbackSql = `SELECT ${nameCol} AS name_place
                           FROM places WHERE id_place = $1`;
      try {
        const result = await pool.query(fallbackSql, [id]);
        infoRow = result.rows[0] || null;
      } catch (e) {
        console.warn('Place fallback query failed:', e.message);
      }
    }

    let images = [];
    try {
      const photos = await pool.query(
        'SELECT photo_binary FROM photos WHERE place_id = $1',
        [id]
      );
      const compressedPhotos = await formatRows(photos.rows, 800);
      images = compressedPhotos.map(p => p.photo_binary).filter(Boolean);
    } catch (e) {
      console.warn('Place photos unavailable:', e.message);
    }

    res.json({
      name: infoRow?.name_place || '',
      name_place: infoRow?.name_place || '',
      description: infoRow?.description || '',
      description_place: infoRow?.description || '',
      lat: infoRow?.lat != null ? parseFloat(infoRow.lat) : null,
      lon: infoRow?.lon != null ? parseFloat(infoRow.lon) : null,
      images
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Получение списка 
app.get('/api/explore', async (req, res) => {
  const { type, offset, limit, districts } = req.query;
  let sql;
  let params = [parseInt(limit), parseInt(offset)];

  if (type === 'places') {
    sql = `SELECT DISTINCT ON (p.id_place) p.id_place as id, p.name_place as name, ph.photo_binary 
           FROM places p LEFT JOIN photos ph ON p.id_place = ph.place_id`;
    if (districts) {
      sql += ` WHERE p.district_id IN (${districts.split(',').map((_, i) => '$' + (i + 3)).join(',')})`;
      districts.split(',').forEach(d => params.push(parseInt(d)));
    }
    sql += ` ORDER BY p.id_place LIMIT $1 OFFSET $2`;
  } else {
    sql = `SELECT r.id_route as id, r.name_route as name, 
           (SELECT photo_binary FROM photos ph JOIN place_and_route pr ON ph.place_id = pr.place_id WHERE pr.route_id = r.id_route LIMIT 1) 
           FROM routes r`;
    if (districts) {
      sql += ` WHERE EXISTS (SELECT 1 FROM place_and_route par JOIN places pl ON par.place_id = pl.id_place 
              WHERE par.route_id = r.id_route AND pl.district_id IN (${districts.split(',').map((_, i) => '$' + (i + 3)).join(',')}))`;
      districts.split(',').forEach(d => params.push(parseInt(d)));
    }
    sql += ` LIMIT $1 OFFSET $2`;
  }

  try {
    const result = await pool.query(sql, params);
    const data = await formatRows(result.rows, 300);
    res.json(data);
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// Получение точек маршрута
app.get('/api/route-points/:id', async (req, res) => {
  try {
    const desc = await pool.query('SELECT description FROM routes WHERE id_route = $1', [req.params.id]);
    const pointsRes = await pool.query(`
      SELECT ST_Y(p.location::geometry) as lat, ST_X(p.location::geometry) as lon, p.name_place 
      FROM places p JOIN place_and_route par ON p.id_place = par.place_id 
      WHERE par.route_id = $1 ORDER BY par.order_number`, [req.params.id]);
    
    const points = pointsRes.rows;
    if (points.length < 2) {
        return res.json({ description: desc.rows[0]?.description, points, geometry: [] });
    }

    const coordsForORS = points.map(p => [parseFloat(p.lon), parseFloat(p.lat)]);

    try {
      // Запрос к OpenRouteService (пешеходный профиль)
      const orsResponse = await axios.post(
        'https://api.openrouteservice.org/v2/directions/foot-walking/geojson',
        {
          coordinates: coordsForORS,
          language: "ru",
          preference: "shortest"
        },
        {
          headers: {
            'Authorization': process.env.ORS_API_KEY, 
            'Content-Type': 'application/json'
          }
        }
      );

      const roadGeometry = orsResponse.data.features[0].geometry.coordinates;

      res.json({
        description: desc.rows[0]?.description,
        points: points, 
        roadPath: roadGeometry.map(c => ({ lat: c[1], lon: c[0] })) // Превращаем [lon, lat] в {lat, lon}
      });

    } catch (orsError) {
      console.error("ORS API Error:", orsError.response ? orsError.response.data : orsError.message);
      res.json({
        description: desc.rows[0]?.description,
        points: points,
        roadPath: [] 
      });
    }

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/get-path', async (req, res) => {
  const { startLat, startLon, endLat, endLon } = req.query;
  try {
    const orsUrl = 'https://api.openrouteservice.org/v2/directions/foot-walking/geojson';
    const orsRes = await axios.post(orsUrl, {
      coordinates: [[startLon, startLat], [endLon, endLat]],
      language: "ru"
    }, {
      headers: { 'Authorization': process.env.ORS_API_KEY, 'Content-Type': 'application/json' }
    });

    const roadGeometry = orsRes.data.features[0].geometry.coordinates;
    res.json(roadGeometry.map(c => ({ lat: c[1], lon: c[0] })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/profile/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    let row = null;
    try {
      const result = await pool.query(
        `SELECT u.fio, u.phone, u.mail, gp.bio, gp.experience, gp.social_link
         FROM users u
         LEFT JOIN guide_profiles gp ON gp.user_id = u.id_user
         WHERE u.id_user = $1`,
        [userId]
      );
      row = result.rows[0];
    } catch (e) {
      const fallback = await pool.query(
        'SELECT fio, phone, mail FROM users WHERE id_user = $1',
        [userId]
      );
      row = fallback.rows[0];
    }
    if (!row) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    res.json({
      name: row.fio || '',
      phone: row.phone || '',
      mail: row.mail || '',
      vk: row.social_link || '',
      experience: row.experience || '',
      about: row.bio || ''
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// РЕГИСТРАЦИЯ
app.post('/api/register', async (req, res) => {
  const { fio, login, mail, phone, pass } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO users (fio, login, mail, phone, pass, role_id, created) 
       VALUES ($1, $2, $3, $4, $5, 1, CURRENT_TIMESTAMP) RETURNING id_user`,
      [fio, login, mail, phone, pass]
    );
    res.json({ success: true, userId: result.rows[0].id_user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка регистрации." });
  }
});

// ВХОД
app.post('/api/login', async (req, res) => {
  const { login, pass } = req.body;
  try {
    const result = await pool.query(
      'SELECT id_user, fio, role_id FROM users WHERE login = $1 AND pass = $2',
      [login, pass]
    );

    if (result.rows.length > 0) {
      const user = result.rows[0];
      res.json({ 
        success: true, 
        userId: user.id_user, 
        roleId: user.role_id,
        name: user.fio
      });
    } else {
      res.status(401).json({ error: "Неверный логин или пароль" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

let toursMetaCache = null;

async function getToursTableMeta() {
  if (toursMetaCache) return toursMetaCache;
  try {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tours'`
    );
    const names = rows.map(r => r.column_name);
    toursMetaCache = {
      guideCol: ['guide_id', 'user_id', 'id_guide', 'guide', 'id_user'].find(c => names.includes(c)),
      statusCol: ['status_tour', 'status', 'tour_status', 'state'].find(c => names.includes(c)),
      durationCol: ['tour_time', 'duration', 'duration_tour', 'time_tour', 'length'].find(c => names.includes(c))
    };
  } catch (e) {
    toursMetaCache = { guideCol: null, statusCol: null, durationCol: null };
  }
  return toursMetaCache;
}

function formatTourDuration(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!raw || raw === 'null') return null;

  const clock = raw.match(/^(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/);
  if (clock) {
    const totalHours = parseInt(clock[1], 10);
    const minutes = parseInt(clock[2], 10);
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    const parts = [];
    if (days > 0) parts.push(`${days} дн.`);
    if (hours > 0) parts.push(`${hours} ч.`);
    if (minutes > 0 && days === 0) parts.push(`${minutes} мин.`);
    return parts.length > 0 ? parts.join(' ') : '—';
  }

  const dayMatch = raw.match(/(\d+)\s*day/i);
  if (dayMatch) {
    const days = parseInt(dayMatch[1], 10);
    return days > 0 ? `${days} дн.` : raw;
  }

  return raw;
}

function normalizeTourStatus(value) {
  const raw = String(value ?? '1').toLowerCase().trim();
  if (raw === '2' || raw.includes('скрыт') || raw.includes('hidden')) return 'hidden';
  if (raw === '3' || raw.includes('черновик') || raw.includes('draft')) return 'draft';
  return 'active';
}

function isArchiveStatus(value) {
  const status = normalizeTourStatus(value);
  return status === 'hidden' || status === 'draft';
}

function statusApiToDbCandidates(statusApi) {
  const map = {
    active: [1, '1', 'active', 'активен', 'активный'],
    hidden: [2, '2', 'hidden', 'скрыт', 'скрытый'],
    draft: [3, '3', 'draft', 'черновик']
  };
  return map[statusApi] || map.active;
}

async function queryGuideTours(guideUserId, archived) {
  const meta = await getToursTableMeta();
  const statusSelect = meta.statusCol ? `, t.${meta.statusCol} AS tour_status` : ", 'active' AS tour_status";
  const durationSelect = meta.durationCol
    ? `, t.${meta.durationCol}::text AS duration`
    : ", NULL AS duration";
  const selectSql = `SELECT t.id_tour, t.name_tour, t.price${statusSelect}${durationSelect} FROM tours t`;

  let rows = [];
  if (meta.guideCol) {
    rows = (await pool.query(
      `${selectSql} WHERE t.${meta.guideCol} = $1 ORDER BY t.name_tour`,
      [guideUserId]
    )).rows;
  } else {
    const variants = [
      `${selectSql}
       JOIN guides_and_tours gt ON gt.tour_id = t.id_tour
       JOIN guide_profiles gp ON gp.id_guide = gt.guide_id
       WHERE gp.user_id = $1
       ORDER BY t.name_tour`,
      `${selectSql}
       JOIN guides_and_tours gt ON gt.tour_id = t.id_tour
       JOIN users u ON u.id_user = gt.guide_id AND u.role_id = 2
       WHERE u.id_user = $1
       ORDER BY t.name_tour`
    ];
    for (const sql of variants) {
      try {
        rows = (await pool.query(sql, [guideUserId])).rows;
        break;
      } catch (e) {
        console.warn('Guide tours query failed:', e.message);
      }
    }
  }

  return rows
    .map(row => ({
      id_tour: row.id_tour,
      name_tour: row.name_tour,
      price: row.price,
      duration: formatTourDuration(row.duration),
      status: normalizeTourStatus(row.tour_status)
    }))
    .filter(row => archived ? isArchiveStatus(row.status) : !isArchiveStatus(row.status));
}

app.get('/api/guide/:userId/tours', async (req, res) => {
  try {
    const archived = req.query.archived === 'true';
    res.json(await queryGuideTours(req.params.userId, archived));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/guide/tours/:tourId', async (req, res) => {
  const tourId = req.params.tourId;
  try {
    const meta = await getToursTableMeta();
    const statusSelect = meta.statusCol ? `, ${meta.statusCol} AS tour_status` : ", 'active' AS tour_status";
    const durationSelect = meta.durationCol
      ? `, ${meta.durationCol}::text AS duration`
      : ", NULL AS duration";
    const tourRes = await pool.query(
      `SELECT id_tour, name_tour, description, price${statusSelect}${durationSelect}
       FROM tours WHERE id_tour = $1`,
      [tourId]
    );
    if (tourRes.rows.length === 0) {
      return res.status(404).json({ error: 'Тур не найден' });
    }
    const tour = tourRes.rows[0];
    let places = [];
    try {
      places = await getTourPlaces(tourId);
    } catch (e) {
      console.warn('Guide tour places unavailable:', e.message);
    }
    res.json({
      id_tour: tour.id_tour,
      name: tour.name_tour,
      description: tour.description || '',
      price: tour.price,
      duration: formatTourDuration(tour.duration),
      status: normalizeTourStatus(tour.tour_status),
      places: places.map(p => ({ id: p.id_place, name: p.name_place || p.name }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/guide/tours/:tourId/status', async (req, res) => {
  const tourId = req.params.tourId;
  const { status } = req.body;
  const allowed = ['active', 'hidden', 'draft'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Недопустимый статус' });
  }
  try {
    const meta = await getToursTableMeta();
    if (!meta.statusCol) {
      return res.status(400).json({ error: 'Статус туров не поддерживается в базе данных' });
    }
    const candidates = statusApiToDbCandidates(status);
    let updated = false;
    for (const value of candidates) {
      try {
        const result = await pool.query(
          `UPDATE tours SET ${meta.statusCol} = $1 WHERE id_tour = $2 RETURNING id_tour`,
          [value, tourId]
        );
        if (result.rows.length > 0) {
          updated = true;
          break;
        }
      } catch (e) {
        console.warn('Status update failed:', e.message);
      }
    }
    if (!updated) {
      return res.status(500).json({ error: 'Не удалось обновить статус' });
    }
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/guide/:userId/bookings', async (req, res) => {
  const guideId = req.params.userId;
  const meta = await getToursTableMeta();
  const variants = [
    {
      join: 'JOIN tours t ON ts.tour = t.id_tour',
      scheduleCol: 'b.tour_schedule = ts.id_tour_schedule'
    },
    {
      join: 'JOIN tours t ON ts.tour_id = t.id_tour',
      scheduleCol: 'b.tour_schedule = ts.id_tour_schedule'
    },
    {
      join: 'JOIN tours t ON ts.tour_id = t.id_tour',
      scheduleCol: 'b.tour_schedule_id = ts.id_tour_schedule'
    }
  ];

  try {
    let rows = [];
    for (const variant of variants) {
      try {
        let sql = `SELECT b.id_booking, t.id_tour, t.name_tour, ts.datetime_start,
                          b.count_people, u.fio AS client_name
                   FROM bookings b
                   JOIN tours_schedule ts ON ${variant.scheduleCol}
                   ${variant.join}
                   LEFT JOIN users u ON b.user_id = u.id_user`;
        const params = [];
        if (meta.guideCol) {
          sql += ` WHERE t.${meta.guideCol} = $1`;
        } else {
          sql += ` JOIN guides_and_tours gt ON gt.tour_id = t.id_tour
                   JOIN guide_profiles gp ON gp.id_guide = gt.guide_id
                   WHERE gp.user_id = $1`;
        }
        params.push(guideId);
        sql += ' ORDER BY ts.datetime_start DESC';
        rows = (await pool.query(sql, params)).rows;
        break;
      } catch (e) {
        console.warn('Guide bookings query failed:', e.message);
      }
    }
    res.json(groupGuideBookings(rows.map(r => ({
      id_booking: r.id_booking,
      id_tour: r.id_tour,
      name_tour: r.name_tour,
      datetime_start: r.datetime_start,
      count_people: r.count_people || 1,
      client_name: r.client_name || 'Клиент'
    }))));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function findAdminUserId() {
  const queries = [
    `SELECT u.id_user FROM users u
     JOIN roles r ON u.role_id = r.id_role
     WHERE LOWER(r.name_role) LIKE '%admin%' OR LOWER(r.name_role) LIKE '%админ%'
     ORDER BY u.id_user LIMIT 1`,
    'SELECT id_user FROM users WHERE role_id >= 3 ORDER BY id_user LIMIT 1',
    'SELECT id_user FROM users WHERE role_id = 3 ORDER BY id_user LIMIT 1'
  ];
  for (const sql of queries) {
    try {
      const { rows } = await pool.query(sql);
      if (rows.length > 0) return rows[0].id_user;
    } catch (e) {
      console.warn('Admin lookup failed:', e.message);
    }
  }
  return null;
}

async function findSupportMetaThemeId() {
  try {
    const exact = await pool.query(
      `SELECT id_theme FROM themes
       WHERE LOWER(TRIM(name_theme)) = 'поддержка' OR LOWER(TRIM(name_theme)) = 'support'
       ORDER BY id_theme LIMIT 1`
    );
    if (exact.rows.length > 0) return exact.rows[0].id_theme;
    const created = await pool.query(
      `INSERT INTO themes (name_theme) VALUES ('Поддержка') RETURNING id_theme`
    );
    return created.rows[0].id_theme;
  } catch (e) {
    console.warn('Support meta theme failed:', e.message);
    return null;
  }
}

function supportTopicRange(roleId) {
  const role = Number(roleId);
  if (role === 2) return { min: 4, max: 13 };
  return { min: 1, max: 8 };
}

async function isSupportMetaChat(themeId) {
  try {
    const metaId = await findSupportMetaThemeId();
    return metaId != null && Number(themeId) === Number(metaId);
  } catch (e) {
    return false;
  }
}

async function isTourChatTheme(themeId) {
  try {
    const { rows } = await pool.query('SELECT name_theme FROM themes WHERE id_theme = $1', [themeId]);
    if (rows.length === 0) return false;
    return String(rows[0].name_theme || '').startsWith('Тур:');
  } catch (e) {
    return false;
  }
}

async function getOrCreateTourTheme(tourName) {
  const themeName = `Тур: ${tourName}`;
  try {
    const existing = await pool.query(
      'SELECT id_theme FROM themes WHERE name_theme = $1 LIMIT 1',
      [themeName]
    );
    if (existing.rows.length > 0) return existing.rows[0].id_theme;
    const created = await pool.query(
      'INSERT INTO themes (name_theme) VALUES ($1) RETURNING id_theme',
      [themeName]
    );
    return created.rows[0].id_theme;
  } catch (e) {
    console.warn('Tour theme create failed:', e.message);
    return null;
  }
}

async function resolveGuideUserIdForTour(tourId) {
  if (!tourId) return null;

  const profileQueries = [
    `SELECT gp.user_id
     FROM guides_and_tours gt
     JOIN guide_profiles gp ON gp.id_guide = gt.guide_id
     WHERE gt.tour_id = $1
     ORDER BY gt.id_guide_tour LIMIT 1`,
    `SELECT u.id_user
     FROM guides_and_tours gt
     JOIN users u ON u.id_user = gt.guide_id AND u.role_id = 2
     WHERE gt.tour_id = $1
     ORDER BY gt.id_guide_tour LIMIT 1`
  ];
  for (const sql of profileQueries) {
    try {
      const { rows } = await pool.query(sql, [tourId]);
      if (rows.length > 0 && rows[0].user_id) return rows[0].user_id;
    } catch (e) {
      console.warn('Guide resolve via guides_and_tours failed:', e.message);
    }
  }

  try {
    const meta = await getToursTableMeta();
    if (meta.guideCol) {
      const { rows } = await pool.query(
        `SELECT ${meta.guideCol} AS user_id FROM tours WHERE id_tour = $1`,
        [tourId]
      );
      if (rows.length > 0 && rows[0].user_id) return rows[0].user_id;
    }
  } catch (e) {
    console.warn('Guide resolve via tours failed:', e.message);
  }

  return null;
}

async function ensureTourChat(clientId, guideId, tourName) {
  if (!clientId || !guideId || !tourName) return null;
  const themeId = await getOrCreateTourTheme(tourName);
  if (!themeId) return null;
  try {
    const existing = await pool.query(
      `SELECT c.id_chat FROM chats c
       JOIN participants_chats pc1 ON pc1.chat_id = c.id_chat AND pc1.user_id = $1
       JOIN participants_chats pc2 ON pc2.chat_id = c.id_chat AND pc2.user_id = $2
       WHERE c.theme = $3
       ORDER BY c.id_chat DESC LIMIT 1`,
      [clientId, guideId, themeId]
    );
    if (existing.rows.length > 0) return existing.rows[0].id_chat;

    const chatRes = await pool.query(
      'INSERT INTO chats (date_chat, theme) VALUES (CURRENT_TIMESTAMP, $1) RETURNING id_chat',
      [themeId]
    );
    const chatId = chatRes.rows[0].id_chat;
    await pool.query(
      'INSERT INTO participants_chats (chat_id, user_id) VALUES ($1, $2), ($1, $3)',
      [chatId, clientId, guideId]
    );
    return chatId;
  } catch (e) {
    console.warn('Ensure tour chat failed:', e.message);
    return null;
  }
}

async function syncTourChats(userId, roleId) {
  const variants = [
    {
      join: 'JOIN tours t ON ts.tour = t.id_tour',
      scheduleCol: 'b.tour_schedule = ts.id_tour_schedule'
    },
    {
      join: 'JOIN tours t ON ts.tour_id = t.id_tour',
      scheduleCol: 'b.tour_schedule = ts.id_tour_schedule'
    },
    {
      join: 'JOIN tours t ON ts.tour_id = t.id_tour',
      scheduleCol: 'b.tour_schedule_id = ts.id_tour_schedule'
    }
  ];

  for (const variant of variants) {
    try {
      let sql = `SELECT DISTINCT b.user_id AS client_id, t.id_tour, t.name_tour
                 FROM bookings b
                 JOIN tours_schedule ts ON ${variant.scheduleCol}
                 ${variant.join}`;
      const params = [];
      if (Number(roleId) === 2) {
        const meta = await getToursTableMeta();
        if (meta.guideCol) {
          sql += ` WHERE t.${meta.guideCol} = $1`;
        } else {
          sql += ` JOIN guides_and_tours gt ON t.id_tour = gt.tour_id
                   JOIN guide_profiles gp ON gp.id_guide = gt.guide_id
                   WHERE gp.user_id = $1`;
        }
        params.push(userId);
      } else {
        sql += ` WHERE b.user_id = $1`;
        params.push(userId);
      }

      const { rows } = await pool.query(sql, params);
      for (const row of rows) {
        const guideUserId = await resolveGuideUserIdForTour(row.id_tour);
        if (guideUserId) {
          await ensureTourChat(row.client_id, guideUserId, row.name_tour);
        }
      }
      return;
    } catch (e) {
      console.warn('Sync tour chats failed:', e.message);
    }
  }
}

async function getChatParticipantId(chatId, userId) {
  const { rows } = await pool.query(
    'SELECT id_participant FROM participants_chats WHERE chat_id = $1 AND user_id = $2',
    [chatId, userId]
  );
  return rows.length > 0 ? rows[0].id_participant : null;
}

async function userInChat(chatId, userId) {
  return (await getChatParticipantId(chatId, userId)) != null;
}

async function getOtherParticipantName(chatId, userId) {
  try {
    const { rows } = await pool.query(
      `SELECT u.fio FROM participants_chats pc
       JOIN users u ON pc.user_id = u.id_user
       WHERE pc.chat_id = $1 AND pc.user_id <> $2
       ORDER BY pc.id_participant LIMIT 1`,
      [chatId, userId]
    );
    return rows.length > 0 ? rows[0].fio : 'Собеседник';
  } catch (e) {
    return 'Собеседник';
  }
}

async function queryUserChats(userId, supportOnly, roleId) {
  try {
    if (!supportOnly) {
      await syncTourChats(userId, roleId);
    }

    const { rows } = await pool.query(
      `SELECT c.id_chat, c.date_chat, c.theme, t.name_theme AS topic
       FROM chats c
       JOIN themes t ON c.theme = t.id_theme
       JOIN participants_chats pc ON pc.chat_id = c.id_chat
       WHERE pc.user_id = $1
       ORDER BY c.date_chat DESC NULLS LAST, c.id_chat DESC`,
      [userId]
    );
    const filtered = [];
    for (const row of rows) {
      const isSupport = await isSupportMetaChat(row.theme);
      const isTour = await isTourChatTheme(row.theme);
      if (supportOnly) {
        if (!isSupport) continue;
      } else if (!isTour) {
        continue;
      }

      let partnerName = await getOtherParticipantName(row.id_chat, userId);
      if (supportOnly) partnerName = 'Поддержка';

      filtered.push({
        id_chat: row.id_chat,
        topic: supportOnly ? '' : String(row.topic || 'Чат').replace(/^Тур:\s*/, ''),
        partner_name: partnerName,
        date_chat: row.date_chat,
        is_support: isSupport
      });
    }
    return filtered;
  } catch (e) {
    console.warn('User chats query failed:', e.message);
    return [];
  }
}

app.get('/api/guide/:userId/reviews', async (req, res) => {
  const guideId = req.params.userId;
  const variants = [
    `SELECT r.id_review, COALESCE(b.date_booking, r.id_review::text) AS review_date,
            u.fio AS client_name, r.rating, r.comment AS text
     FROM reviews r
     JOIN bookings b ON r.booking_id = b.id_booking
     JOIN tours_schedule ts ON b.tour_schedule = ts.id_tour_schedule
     JOIN tours t ON ts.tour = t.id_tour
     JOIN guides_and_tours gt ON t.id_tour = gt.tour_id
     JOIN guide_profiles gp ON gp.id_guide = gt.guide_id
     JOIN users u ON b.user_id = u.id_user
     WHERE gp.user_id = $1
     ORDER BY r.id_review DESC`,
    `SELECT r.id_review, COALESCE(b.date_booking, r.id_review::text) AS review_date,
            u.fio AS client_name, r.rating, r.text_review AS text
     FROM reviews r
     JOIN bookings b ON r.booking_id = b.id_booking
     JOIN tours_schedule ts ON b.tour_schedule = ts.id_tour_schedule
     JOIN tours t ON ts.tour = t.id_tour
     JOIN guides_and_tours gt ON t.id_tour = gt.tour_id
     JOIN guide_profiles gp ON gp.id_guide = gt.guide_id
     JOIN users u ON b.user_id = u.id_user
     WHERE gp.user_id = $1
     ORDER BY r.id_review DESC`,
    `SELECT r.id_review, COALESCE(b.date_booking, r.id_review::text) AS review_date,
            u.fio AS client_name, r.rating, COALESCE(r.comment, r.text_review) AS text
     FROM reviews r
     JOIN bookings b ON r.booking_id = b.id_booking
     JOIN tours_schedule ts ON b.tour_schedule = ts.id_tour_schedule
     JOIN tours t ON ts.tour_id = t.id_tour
     JOIN guides_and_tours gt ON t.id_tour = gt.tour_id
     JOIN guide_profiles gp ON gp.id_guide = gt.guide_id
     JOIN users u ON b.user_id = u.id_user
     WHERE gp.user_id = $1
     ORDER BY r.id_review DESC`
  ];
  try {
    for (const sql of variants) {
      try {
        const { rows } = await pool.query(sql, [guideId]);
        return res.json(rows.map(r => ({
          id_review: r.id_review,
          date: r.review_date,
          client_name: r.client_name || 'Клиент',
          rating: r.rating,
          comment: r.text || ''
        })));
      } catch (e) {
        console.warn('Guide reviews query failed:', e.message);
      }
    }
    res.json([]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chats/support-topics', async (req, res) => {
  try {
    let roleId = Number(req.query.roleId);
    if (req.query.userId) {
      try {
        const { rows } = await pool.query(
          'SELECT role_id FROM users WHERE id_user = $1',
          [req.query.userId]
        );
        if (rows.length > 0) roleId = rows[0].role_id;
      } catch (e) {
        console.warn('Support topics role lookup failed:', e.message);
      }
    }
    const { min, max } = supportTopicRange(roleId);
    const { rows } = await pool.query(
      `SELECT id_theme, name_theme FROM themes
       WHERE id_theme >= $1 AND id_theme <= $2
       ORDER BY id_theme`,
      [min, max]
    );
    res.json(rows.map(r => ({
      id_theme: r.id_theme,
      name: r.name_theme
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chats/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const mode = req.query.mode === 'support' ? 'support' : 'regular';
    const roleId = req.query.roleId || 1;
    const chats = await queryUserChats(userId, mode === 'support', roleId);
    res.json(chats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chats/support', async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'userId обязателен' });
  }
  try {
    const adminId = await findAdminUserId();
    const themeId = await findSupportMetaThemeId();
    if (!adminId || !themeId) {
      return res.status(500).json({ error: 'Поддержка временно недоступна' });
    }

    const existing = await pool.query(
      `SELECT c.id_chat FROM chats c
       JOIN participants_chats pc1 ON pc1.chat_id = c.id_chat AND pc1.user_id = $1
       JOIN participants_chats pc2 ON pc2.chat_id = c.id_chat AND pc2.user_id = $2
       WHERE c.theme = $3
       ORDER BY c.id_chat DESC LIMIT 1`,
      [userId, adminId, themeId]
    );
    if (existing.rows.length > 0) {
      return res.json({
        id_chat: existing.rows[0].id_chat,
        topic: 'Поддержка',
        partner_name: 'Поддержка',
        is_support: true
      });
    }

    const chatRes = await pool.query(
      'INSERT INTO chats (date_chat, theme) VALUES (CURRENT_TIMESTAMP, $1) RETURNING id_chat',
      [themeId]
    );
    const chatId = chatRes.rows[0].id_chat;
    await pool.query(
      'INSERT INTO participants_chats (chat_id, user_id) VALUES ($1, $2), ($1, $3)',
      [chatId, userId, adminId]
    );
    res.json({ id_chat: chatId, topic: 'Поддержка', partner_name: 'Поддержка', is_support: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chats/:chatId/messages', async (req, res) => {
  const chatId = req.params.chatId;
  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).json({ error: 'userId обязателен' });
  }
  try {
    if (!(await userInChat(chatId, userId))) {
      return res.status(403).json({ error: 'Нет доступа к чату' });
    }

    const header = await pool.query(
      `SELECT c.theme, t.name_theme AS topic FROM chats c
       JOIN themes t ON c.theme = t.id_theme
       WHERE c.id_chat = $1`,
      [chatId]
    );
    const isSupport = header.rows.length > 0
      ? await isSupportMetaChat(header.rows[0].theme)
      : false;
    const partnerName = isSupport ? 'Поддержка' : await getOtherParticipantName(chatId, userId);
    const topic = isSupport
      ? 'Поддержка'
      : String(header.rows[0]?.topic || 'Чат').replace(/^Тур:\s*/, '');

    const { rows } = await pool.query(
      `SELECT m.id_message, m.text_message, m.send_time, pc.user_id, u.fio, u.role_id
       FROM messages m
       JOIN participants_chats pc ON m.participant_id = pc.id_participant
       JOIN users u ON pc.user_id = u.id_user
       WHERE pc.chat_id = $1
       ORDER BY m.send_time ASC NULLS LAST, m.id_message ASC`,
      [chatId]
    );

    res.json({
      topic,
      partner_name: partnerName,
      is_support: isSupport,
      messages: rows.map(r => ({
        id_message: r.id_message,
        text: r.text_message || '',
        send_time: r.send_time,
        user_id: r.user_id,
        sender_name: r.fio || 'Пользователь',
        is_mine: String(r.user_id) === String(userId),
        is_topic: String(r.text_message || '').startsWith('[Тема:')
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chats/:chatId/messages', async (req, res) => {
  const chatId = req.params.chatId;
  const { userId, text, themeId, roleId } = req.body;
  if (!userId || !text || !String(text).trim()) {
    return res.status(400).json({ error: 'userId и text обязательны' });
  }
  try {
    const participantId = await getChatParticipantId(chatId, userId);
    if (!participantId) {
      return res.status(403).json({ error: 'Нет доступа к чату' });
    }

    const chatInfo = await pool.query('SELECT theme FROM chats WHERE id_chat = $1', [chatId]);
    const isSupport = chatInfo.rows.length > 0
      ? await isSupportMetaChat(chatInfo.rows[0].theme)
      : false;

    let messageText = String(text).trim();
    if (isSupport) {
      let effectiveRoleId = Number(roleId);
      try {
        const { rows } = await pool.query('SELECT role_id FROM users WHERE id_user = $1', [userId]);
        if (rows.length > 0) effectiveRoleId = rows[0].role_id;
      } catch (e) {
        console.warn('Message role lookup failed:', e.message);
      }
      const isAdminUser = effectiveRoleId >= 3;
      if (!themeId && !isAdminUser) {
        return res.status(400).json({ error: 'Выберите тему обращения' });
      }
      if (themeId) {
        const range = supportTopicRange(effectiveRoleId);
        const themeNum = Number(themeId);
        if (themeNum < range.min || themeNum > range.max) {
          return res.status(400).json({ error: 'Недопустимая тема обращения' });
        }
        const themeRes = await pool.query(
          'SELECT name_theme FROM themes WHERE id_theme = $1',
          [themeId]
        );
        if (themeRes.rows.length === 0) {
          return res.status(400).json({ error: 'Тема не найдена' });
        }
        messageText = `[Тема: ${themeRes.rows[0].name_theme}]\n${messageText}`;
      }
    }

    const result = await pool.query(
      `INSERT INTO messages (participant_id, text_message, send_time)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       RETURNING id_message, text_message, send_time`,
      [participantId, messageText]
    );
    const row = result.rows[0];
    res.json({
      success: true,
      message: {
        id_message: row.id_message,
        text: row.text_message,
        send_time: row.send_time,
        user_id: userId,
        is_mine: true,
        is_topic: String(row.text_message || '').startsWith('[Тема:')
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const GUIDE_STATUS_MAP = { active: 1, review: 3, suspended: 2 };

async function getLatestGuideStatusId(guideId) {
  try {
    const { rows } = await pool.query(
      `SELECT status_verification_id FROM guide_verifications
       WHERE guide_id = $1 ORDER BY id_verification DESC LIMIT 1`,
      [guideId]
    );
    return rows.length > 0 ? rows[0].status_verification_id : 3;
  } catch (e) {
    return 3;
  }
}

function guideStatusApiFromId(statusId) {
  if (statusId === 1) return 'active';
  if (statusId === 3) return 'review';
  if (statusId === 2) return 'suspended';
  return 'review';
}

async function extractSupportTopic(chatId) {
  try {
    const { rows } = await pool.query(
      `SELECT m.text_message FROM messages m
       JOIN participants_chats pc ON m.participant_id = pc.id_participant
       WHERE pc.chat_id = $1 AND m.text_message LIKE '[Тема:%'
       ORDER BY m.id_message ASC LIMIT 1`,
      [chatId]
    );
    if (rows.length === 0) return '';
    const text = String(rows[0].text_message || '');
    const match = text.match(/^\[Тема:\s*(.+?)\]/);
    return match ? match[1].trim() : '';
  } catch (e) {
    return '';
  }
}

app.get('/api/admin/guides', async (req, res) => {
  const statusId = req.query.status === 'review' ? 3 : 1;
  const q = String(req.query.q || '').trim().toLowerCase();
  try {
    const { rows } = await pool.query(
      `SELECT gp.id_guide, u.id_user, u.fio, u.phone,
              COALESCE(lv.status_verification_id, 3) AS status_id,
              sv.name_status_verification AS status_name
       FROM guide_profiles gp
       JOIN users u ON u.id_user = gp.user_id
       LEFT JOIN LATERAL (
         SELECT status_verification_id FROM guide_verifications
         WHERE guide_id = gp.id_guide
         ORDER BY id_verification DESC LIMIT 1
       ) lv ON true
       LEFT JOIN status_verifications sv ON sv.id_status_verification = COALESCE(lv.status_verification_id, 3)
       WHERE COALESCE(lv.status_verification_id, 3) = $1
         AND ($2 = '' OR LOWER(u.fio) LIKE '%' || $2 || '%')
       ORDER BY u.fio`,
      [statusId, q]
    );
    res.json(rows.map(r => ({
      id_guide: r.id_guide,
      user_id: r.id_user,
      fio: r.fio,
      phone: r.phone || '',
      status: guideStatusApiFromId(r.status_id),
      status_name: r.status_name || ''
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/guides/:guideId', async (req, res) => {
  const guideId = req.params.guideId;
  try {
    const profileRes = await pool.query(
      `SELECT gp.id_guide, u.id_user, u.fio, u.phone, u.mail,
              gp.bio, gp.experience, gp.social_link,
              COALESCE(lv.status_verification_id, 3) AS status_id,
              sv.name_status_verification AS status_name
       FROM guide_profiles gp
       JOIN users u ON u.id_user = gp.user_id
       LEFT JOIN LATERAL (
         SELECT status_verification_id FROM guide_verifications
         WHERE guide_id = gp.id_guide
         ORDER BY id_verification DESC LIMIT 1
       ) lv ON true
       LEFT JOIN status_verifications sv ON sv.id_status_verification = COALESCE(lv.status_verification_id, 3)
       WHERE gp.id_guide = $1`,
      [guideId]
    );
    if (profileRes.rows.length === 0) {
      return res.status(404).json({ error: 'Гид не найден' });
    }
    const profile = profileRes.rows[0];

    let organizations = [];
    try {
      const orgRes = await pool.query(
        `SELECT DISTINCT o.name_organization
         FROM organization_users ou
         JOIN organizations o ON o.id_organization = ou.organization_id
         WHERE ou.user_id = $1`,
        [profile.id_user]
      );
      organizations = orgRes.rows.map(r => r.name_organization).filter(Boolean);
    } catch (e) {
      console.warn('Guide org lookup failed:', e.message);
    }

    let tours = [];
    try {
      const toursRes = await pool.query(
        `SELECT t.id_tour, t.name_tour
         FROM guides_and_tours gt
         JOIN tours t ON t.id_tour = gt.tour_id
         WHERE gt.guide_id = $1
         ORDER BY t.name_tour`,
        [guideId]
      );
      tours = toursRes.rows;
    } catch (e) {
      console.warn('Guide tours lookup failed:', e.message);
    }

    res.json({
      id_guide: profile.id_guide,
      user_id: profile.id_user,
      fio: profile.fio,
      phone: profile.phone || '',
      mail: profile.mail || '',
      social_link: profile.social_link || '',
      bio: profile.bio || '',
      experience: profile.experience || '',
      organizations,
      tours: tours.map(t => ({ id_tour: t.id_tour, name: t.name_tour })),
      status: guideStatusApiFromId(profile.status_id),
      status_name: profile.status_name || ''
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/guides/:guideId/status', async (req, res) => {
  const guideId = req.params.guideId;
  const { adminId, status } = req.body;
  const statusId = GUIDE_STATUS_MAP[status];
  if (!statusId) {
    return res.status(400).json({ error: 'Недопустимый статус' });
  }
  try {
    await pool.query(
      `INSERT INTO guide_verifications (guide_id, admin_id, status_verification_id)
       VALUES ($1, $2, $3)`,
      [guideId, adminId || null, statusId]
    );
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/content', async (req, res) => {
  const type = req.query.type || 'places';
  const offset = parseInt(req.query.offset, 10) || 0;
  const limit = parseInt(req.query.limit, 10) || 20;
  const q = String(req.query.q || '').trim().toLowerCase();
  const districts = req.query.districts;
  let sql;
  const params = [limit, offset, q];

  if (type === 'places') {
    sql = `SELECT DISTINCT ON (p.id_place) p.id_place AS id, p.name_place AS name, ph.photo_binary
           FROM places p
           LEFT JOIN photos ph ON p.id_place = ph.place_id
           WHERE ($3 = '' OR LOWER(p.name_place) LIKE '%' || $3 || '%')`;
    if (districts) {
      const ids = districts.split(',').map(d => parseInt(d, 10)).filter(Boolean);
      if (ids.length > 0) {
        sql += ` AND p.district_id IN (${ids.map((_, i) => '$' + (i + 4)).join(',')})`;
        params.push(...ids);
      }
    }
    sql += ` ORDER BY p.id_place LIMIT $1 OFFSET $2`;
  } else if (type === 'routes') {
    sql = `SELECT r.id_route AS id, r.name_route AS name,
           (SELECT photo_binary FROM photos ph
            JOIN place_and_route pr ON ph.place_id = pr.place_id
            WHERE pr.route_id = r.id_route LIMIT 1) AS photo_binary
           FROM routes r
           WHERE ($3 = '' OR LOWER(r.name_route) LIKE '%' || $3 || '%')`;
    if (districts) {
      const ids = districts.split(',').map(d => parseInt(d, 10)).filter(Boolean);
      if (ids.length > 0) {
        sql += ` AND EXISTS (
          SELECT 1 FROM place_and_route par
          JOIN places pl ON par.place_id = pl.id_place
          WHERE par.route_id = r.id_route AND pl.district_id IN (${ids.map((_, i) => '$' + (i + 4)).join(',')})
        )`;
        params.push(...ids);
      }
    }
    sql += ` ORDER BY r.name_route LIMIT $1 OFFSET $2`;
  } else {
    sql = `SELECT DISTINCT t.id_tour AS id, t.name_tour AS name, t.photo_binary
           FROM tours t
           JOIN route_and_tour rat ON t.id_tour = rat.tour_id
           JOIN place_and_route par ON rat.route_id = par.route_id
           JOIN places p ON par.place_id = p.id_place
           WHERE ($3 = '' OR LOWER(t.name_tour) LIKE '%' || $3 || '%')`;
    if (districts) {
      const ids = districts.split(',').map(d => parseInt(d, 10)).filter(Boolean);
      if (ids.length > 0) {
        sql += ` AND p.district_id IN (${ids.map((_, i) => '$' + (i + 4)).join(',')})`;
        params.push(...ids);
      }
    }
    sql += ` ORDER BY t.name_tour LIMIT $1 OFFSET $2`;
  }

  try {
    const result = await pool.query(sql, params);
    const data = await formatRows(result.rows, 300);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/content/place/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const { rows } = await pool.query(
      `SELECT p.id_place, p.name_place, p.description, p.address,
              d.name_district, tp.name_type AS type_name,
              ST_Y(p.location::geometry) AS lat,
              ST_X(p.location::geometry) AS lon
       FROM places p
       LEFT JOIN districts d ON d.id_district = p.district_id
       LEFT JOIN types_places tp ON tp.id_type_place = p.type_place_id
       WHERE p.id_place = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Место не найдено' });
    const row = rows[0];
    res.json({
      type: 'place',
      id: row.id_place,
      name: row.name_place,
      district: row.name_district || '',
      description: row.description || '',
      address: row.address || '',
      type_name: row.type_name || '',
      lat: row.lat != null ? parseFloat(row.lat) : null,
      lon: row.lon != null ? parseFloat(row.lon) : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/content/route/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const meta = await pool.query(
      `SELECT r.name_route, r.description, r.duration::text AS duration,
              string_agg(DISTINCT d.name_district, ', ' ORDER BY d.name_district) AS districts
       FROM routes r
       LEFT JOIN place_and_route par ON par.route_id = r.id_route
       LEFT JOIN places p ON p.id_place = par.place_id
       LEFT JOIN districts d ON d.id_district = p.district_id
       WHERE r.id_route = $1
       GROUP BY r.id_route, r.name_route, r.description, r.duration`,
      [id]
    );
    if (meta.rows.length === 0) return res.status(404).json({ error: 'Маршрут не найден' });
    const row = meta.rows[0];
    const points = await getRoutePoints(id);
    const path = await getRoadPath(points, 'foot-walking');
    res.json({
      type: 'route',
      id: parseInt(id, 10),
      name: row.name_route,
      districts: row.districts || '',
      description: row.description || '',
      duration: row.duration || '',
      points,
      path
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/content/tour/:id', async (req, res) => {
  const tourId = parseInt(req.params.id, 10);
  try {
    const meta = await getToursTableMeta();
    const durationSelect = meta.durationCol
      ? `, ${meta.durationCol}::text AS duration`
      : ", NULL AS duration";
    const tourRes = await pool.query(
      `SELECT t.id_tour, t.name_tour, t.description, t.price,
              t.season_start, t.season_end, t.max_people${durationSelect}
       FROM tours t WHERE t.id_tour = $1`,
      [tourId]
    );
    if (tourRes.rows.length === 0) return res.status(404).json({ error: 'Тур не найден' });
    const tour = tourRes.rows[0];

    let districts = '';
    try {
      const distRes = await pool.query(
        `SELECT string_agg(DISTINCT d.name_district, ', ' ORDER BY d.name_district) AS districts
         FROM route_and_tour rat
         JOIN place_and_route par ON par.route_id = rat.route_id
         JOIN places p ON p.id_place = par.place_id
         JOIN districts d ON d.id_district = p.district_id
         WHERE rat.tour_id = $1`,
        [tourId]
      );
      districts = distRes.rows[0]?.districts || '';
    } catch (e) {
      console.warn('Tour districts failed:', e.message);
    }

    let places = [];
    try {
      places = await getTourPlaces(tourId);
    } catch (e) {
      console.warn('Tour places failed:', e.message);
    }

    const routeQueries = [
      `SELECT r.id_route FROM route_and_tour rat
       JOIN routes r ON rat.route_id = r.id_route WHERE rat.tour_id = $1 ORDER BY r.id_route`,
      `SELECT r.id_route FROM route_and_tour rat
       JOIN routes r ON rat.route_id = r.id_route WHERE rat.tour = $1 ORDER BY r.id_route`
    ];
    let routeIds = [];
    for (const sql of routeQueries) {
      try {
        const routesRes = await pool.query(sql, [tourId]);
        if (routesRes.rows.length > 0) {
          routeIds = routesRes.rows.map(r => r.id_route);
          break;
        }
      } catch (e) {
        console.warn('Tour routes query failed:', e.message);
      }
    }

    const segments = [];
    if (routeIds.length >= 2) {
      const carPoints = await getRoutePoints(routeIds[0]);
      const boatPoints = await getRoutePoints(routeIds[1]);
      const boatPath = boatPoints.map(p => ({ lat: parseFloat(p.lat), lon: parseFloat(p.lon) }));
      segments.push({
        type: 'car',
        label: 'Дорога на машине',
        points: carPoints,
        path: await getRoadPath(carPoints, 'driving-car')
      });
      segments.push({ type: 'boat', label: 'Участок без дороги', points: boatPoints, path: boatPath });
    } else if (routeIds.length > 0) {
      const points = await getRoutePoints(routeIds[0]);
      segments.push({
        type: 'car',
        label: 'Маршрут на машине',
        points,
        path: await getRoadPath(points, 'driving-car')
      });
    }

    res.json({
      type: 'tour',
      id: tour.id_tour,
      name: tour.name_tour,
      districts,
      description: tour.description || '',
      price: tour.price,
      duration: formatTourDuration(tour.duration),
      season_start: tour.season_start || null,
      season_end: tour.season_end || null,
      max_people: tour.max_people,
      places: places.map(p => ({ id: p.id_place, name: p.name_place || p.name })),
      segments
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/chats', async (req, res) => {
  const adminId = req.query.adminId;
  const type = req.query.type === 'guides' ? 'guides' : 'clients';
  const roleFilter = type === 'guides' ? 2 : 1;
  if (!adminId) {
    return res.status(400).json({ error: 'adminId обязателен' });
  }
  try {
    const metaThemeId = await findSupportMetaThemeId();
    if (!metaThemeId) return res.json([]);

    const { rows } = await pool.query(
      `SELECT c.id_chat, c.date_chat, u.fio, u.role_id, u.id_user
       FROM chats c
       JOIN participants_chats pc_admin ON pc_admin.chat_id = c.id_chat AND pc_admin.user_id = $1
       JOIN participants_chats pc_other ON pc_other.chat_id = c.id_chat AND pc_other.user_id <> $1
       JOIN users u ON u.id_user = pc_other.user_id
       WHERE c.theme = $2 AND u.role_id = $3
       ORDER BY c.date_chat DESC NULLS LAST, c.id_chat DESC`,
      [adminId, metaThemeId, roleFilter]
    );

    const result = [];
    for (const row of rows) {
      const topic = await extractSupportTopic(row.id_chat);
      result.push({
        id_chat: row.id_chat,
        partner_name: row.fio || 'Пользователь',
        partner_id: row.id_user,
        topic: topic || 'Обращение в поддержку',
        date_chat: row.date_chat,
        is_support: true
      });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/profile/:userId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT fio, phone, mail FROM users WHERE id_user = $1',
      [req.params.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({
      name: rows[0].fio || '',
      phone: rows[0].phone || '',
      mail: rows[0].mail || ''
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sos', async (req, res) => {
  const { userId, lat, lon, tourName, roleLabel } = req.body;
  if (lat == null || lon == null) {
    return res.status(400).json({ error: 'Координаты обязательны' });
  }
  try {
    let fio = 'Пользователь';
    let phone = '';
    if (userId) {
      const { rows } = await pool.query(
        'SELECT fio, phone FROM users WHERE id_user = $1',
        [userId]
      );
      if (rows.length > 0) {
        fio = rows[0].fio || fio;
        phone = rows[0].phone || '';
      }
    }
    const mapLink = `https://www.google.com/maps?q=${lat},${lon}`;
    const text = [
      'SOS-сигнал WalkNorth',
      `От: ${fio} (${roleLabel || 'Пользователь'})`,
      phone ? `Телефон: ${phone}` : null,
      `Тур: ${tourName || '—'}`,
      `Координаты: ${lat}, ${lon}`,
      `Карта: ${mapLink}`
    ].filter(Boolean).join('\n');
    console.log('SOS ALERT:\n' + text);
    res.json({ sent: false, logged: true, message: text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
