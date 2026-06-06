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
    const result = await pool.query('SELECT description, photo_binary FROM districts WHERE id_district = $1', [req.params.id]);
    const row = result.rows[0];
    
    res.json({
      description: row.description,
      images: row.photo_binary ? [row.photo_binary.toString('base64')] : []
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

    const placesRes = await pool.query(
      `SELECT DISTINCT p.id_place, p.name_place
       FROM tours t
       JOIN route_and_tour rat ON t.id_tour = rat.tour_id
       JOIN routes r ON rat.route_id = r.id_route
       JOIN place_and_route par ON r.id_route = par.route_id
       JOIN places p ON par.place_id = p.id_place
       WHERE t.id_tour = $1
       ORDER BY p.name_place`,
      [tourId]
    );

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
      places: placesRes.rows.map(p => ({ id: p.id_place, name: p.name_place })),
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

app.get('/api/tour-schedule/:tourId', async (req, res) => {
  const tourId = req.params.tourId;
  const sqlVariants = [
    `SELECT id_tour_schedule, datetime_start, datetime_end
     FROM tours_schedule
     WHERE tour = $1 AND datetime_start >= CURRENT_DATE
     ORDER BY datetime_start`,
    `SELECT id_tour_schedule, datetime_start, datetime_end
     FROM tours_schedule
     WHERE tour_id = $1 AND datetime_start >= CURRENT_DATE
     ORDER BY datetime_start`
  ];
  try {
    let result;
    try {
      result = await pool.query(sqlVariants[0], [tourId]);
    } catch (e) {
      result = await pool.query(sqlVariants[1], [tourId]);
    }
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bookings', async (req, res) => {
  const { userId, scheduleId, countPeople } = req.body;
  if (!userId || userId === -1 || !scheduleId) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  try {
    const schedule = await pool.query(
      `SELECT id_tour_schedule FROM tours_schedule
       WHERE id_tour_schedule = $1 AND datetime_start >= CURRENT_DATE`,
      [scheduleId]
    );
    if (schedule.rows.length === 0) {
      return res.status(400).json({ error: 'Дата недоступна для бронирования' });
    }

    const result = await pool.query(
      `INSERT INTO bookings (user_id, tour_schedule, status_booking, date_booking, count_people)
       VALUES ($1, $2, 1, CURRENT_TIMESTAMP, $3)
       RETURNING id_booking`,
      [userId, scheduleId, countPeople || 1]
    );
    res.json({ success: true, bookingId: result.rows[0].id_booking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bookings/:userId', async (req, res) => {
  const joinTour = [
    `JOIN tours t ON ts.tour = t.id_tour`,
    `JOIN tours t ON ts.tour_id = t.id_tour`
  ];
  try {
    let result;
    try {
      result = await pool.query(
        `SELECT b.id_booking, t.id_tour, t.name_tour, t.price,
                ts.datetime_start, ts.datetime_end, b.count_people, b.date_booking
         FROM bookings b
         JOIN tours_schedule ts ON b.tour_schedule = ts.id_tour_schedule
         ${joinTour[0]}
         WHERE b.user_id = $1
         ORDER BY ts.datetime_start DESC`,
        [req.params.userId]
      );
    } catch (e) {
      result = await pool.query(
        `SELECT b.id_booking, t.id_tour, t.name_tour, t.price,
                ts.datetime_start, ts.datetime_end, b.count_people, b.date_booking
         FROM bookings b
         JOIN tours_schedule ts ON b.tour_schedule = ts.id_tour_schedule
         ${joinTour[1]}
         WHERE b.user_id = $1
         ORDER BY ts.datetime_start DESC`,
        [req.params.userId]
      );
    }
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

//детали места 
app.get('/api/place-details/:id', async (req, res) => {
  try {
    const info = await pool.query('SELECT description, ST_Y(location::geometry) as lat, ST_X(location::geometry) as lon FROM places WHERE id_place = $1', [req.params.id]);
    const photos = await pool.query('SELECT photo_binary FROM photos WHERE place_id = $1', [req.params.id]);
    const compressedPhotos = await formatRows(photos.rows, 800);
    res.json({
      description: info.rows[0]?.description,
      lat: info.rows[0]?.lat,
      lon: info.rows[0]?.lon,
      images: compressedPhotos.map(p => p.photo_binary)
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
    const result = await pool.query('SELECT fio FROM users WHERE id_user = $1', [req.params.id]);
    if (result.rows.length > 0) {
      res.json({ name: result.rows[0].fio });
    } else {
      res.status(404).json({ error: "Пользователь не найден" });
    }
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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
