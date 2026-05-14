const express = require('express');
const { Pool } = require('pg');
const sharp = require('sharp'); 
const app = express();
const PORT = process.env.PORT || 3000;
const axios = require('axios');

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
    const [districtsRes, nearbyRes] = await Promise.all([districtsPromise, nearbyPromise]);
    const compressedDistricts = await formatRows(districtsRes.rows, 150);
    const compressedNearby = await formatRows(nearbyRes.rows, 350);

    res.json({
      districts: compressedDistricts,
      nearby: compressedNearby
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
                 WHERE p.district_id = $1`;
    const result = await pool.query(sql, [districtId]);
    const data = await formatRows(result.rows, 400);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
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

    const osrmCoords = points.map(p => `${p.lon},${p.lat}`).join(';');
    const osrmUrl = `http://router.project-osrm.org/route/v1/foot/${osrmCoords}?overview=full&geometries=geojson`;
    
    const osrmRes = await axios.get(osrmUrl);
    const roadGeometry = osrmRes.data.routes[0].geometry.coordinates; 

    res.json({
      description: desc.rows[0]?.description,
      points: points, 
      roadPath: roadGeometry.map(c => ({ lat: c[1], lon: c[0] })) 
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
