const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Подключение к БД
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get('/', (req, res) => {
  res.json({ status: 'OK', time: new Date().toISOString() });
});

app.get('/api/db-status', async (req, res) => {
  try {
    const result = await pool.query('SELECT current_database(), current_user');
    res.json({ 
      success: true, 
      database: result.rows[0].current_database,
      user: result.rows[0].current_user 
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});