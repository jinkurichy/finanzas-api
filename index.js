const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Railway proporciona MYSQL_URL o MYSQL_PRIVATE_URL automáticamente
const pool = mysql.createPool(process.env.MYSQL_URL || process.env.MYSQL_PRIVATE_URL || {
  host: process.env.MYSQLHOST || 'localhost',
  user: process.env.MYSQLUSER || 'root',
  password: process.env.MYSQLPASSWORD || '',
  database: process.env.MYSQLDATABASE || 'railway',
  port: process.env.MYSQLPORT || 3306,
  waitForConnections: true,
  connectionLimit: 10
});

// Endpoint de verificación de salud
app.get('/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 + 1 AS solution');
    res.json({ status: 'ok', db: 'connected', solution: rows[0].solution });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 1. Registro / Solicitud de token
app.post('/api/auth/register', async (req, res) => {
  const { name, email, passwordHash } = req.body;
  try {
    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'El correo ya se encuentra registrado.' });
    }
    const token = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutos
    await pool.query(
      'INSERT INTO email_verifications (email, token, user_name, password_hash, expires_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE token = VALUES(token), user_name = VALUES(user_name), password_hash = VALUES(password_hash), expires_at = VALUES(expires_at)',
      [email, token, name, passwordHash, expiresAt]
    );
    res.json({ success: true, message: 'Token de verificación generado', token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Verificación de token y creación de usuario
app.post('/api/auth/verify-token', async (req, res) => {
  const { email, token } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM email_verifications WHERE email = ? AND token = ?', [email, token]);
    if (rows.length === 0) {
      return res.status(400).json({ error: 'Token inválido o correo incorrecto.' });
    }
    const verification = rows[0];
    if (Date.now() > Number(verification.expires_at)) {
      return res.status(400).json({ error: 'El código de seguridad ha caducado.' });
    }
    
    // Correo real en texto plano
    const [result] = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      [verification.user_name, email, verification.password_hash]
    );

    await pool.query('DELETE FROM email_verifications WHERE email = ?', [email]);
    res.json({
      success: true,
      user: { id: result.insertId, name: verification.user_name, email: email, partnerId: null }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Inicio de sesión (Login)
app.post('/api/auth/login', async (req, res) => {
  const { email, passwordHash } = req.body;
  try {
    const [users] = await pool.query('SELECT id, name, email, password_hash, partner_id, biometric_enabled FROM users WHERE email = ?', [email]);
    if (users.length === 0 || users[0].password_hash !== passwordHash) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    }
    const user = users[0];
    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        partnerId: user.partner_id,
        biometricEnabled: Boolean(user.biometric_enabled)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Actualizar preferencia de huella dactilar
app.post('/api/auth/biometric', async (req, res) => {
  const { userId, enabled } = req.body;
  try {
    await pool.query('UPDATE users SET biometric_enabled = ? WHERE id = ?', [enabled ? 1 : 0, userId]);
    res.json({ success: true, biometricEnabled: enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Obtener transacciones (personales y de pareja)
app.get('/api/transactions', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'Falta el parámetro userId' });

  try {
    const [userRows] = await pool.query('SELECT partner_id FROM users WHERE id = ?', [userId]);
    const partnerId = userRows.length > 0 ? userRows[0].partner_id : null;

    let query = 'SELECT * FROM transactions WHERE user_id = ?';
    let params = [userId];

    if (partnerId) {
      query += ' OR user_id = ? OR partner_user_id = ?';
      params.push(partnerId, userId);
    }
    query += ' ORDER BY date DESC';

    const [transactions] = await pool.query(query, params);
    res.json({ transactions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Crear una transacción (gasto o ingreso) con soporte compartido
app.post('/api/transactions', async (req, res) => {
  const { userId, title, amount, category, type, date, note, isShared } = req.body;
  try {
    const [userRows] = await pool.query('SELECT partner_id FROM users WHERE id = ?', [userId]);
    const partnerId = userRows.length > 0 ? userRows[0].partner_id : null;

    // Insert flexible (guarda is_shared si existe la columna, o normal si no)
    try {
      const [result] = await pool.query(
        'INSERT INTO transactions (user_id, partner_user_id, is_shared, title, amount, category, type, date, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [userId, partnerId, isShared ? 1 : 0, title, amount, category, type, date || Date.now(), note || '']
      );
      return res.json({ success: true, id: result.insertId });
    } catch (insertErr) {
      // Fallback si la tabla no tiene is_shared
      const [result] = await pool.query(
        'INSERT INTO transactions (user_id, partner_user_id, title, amount, category, type, date, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [userId, partnerId, title, amount, category, type, date || Date.now(), note || '']
      );
      return res.json({ success: true, id: result.insertId });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Generar código de emparejamiento para pareja
app.post('/api/pair/generate', async (req, res) => {
  const { userId } = req.body;
  try {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    await pool.query(
      'INSERT INTO pairing_codes (code, user_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)',
      [code, userId]
    );
    res.json({ success: true, code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Vincular con código de pareja
app.post('/api/pair/link', async (req, res) => {
  const { userId, code } = req.body;
  try {
    const [codes] = await pool.query('SELECT user_id FROM pairing_codes WHERE code = ?', [code]);
    if (codes.length === 0) {
      return res.status(404).json({ error: 'Código de emparejamiento no válido o expirado.' });
    }
    const partnerId = codes[0].user_id;
    if (partnerId === Number(userId)) {
      return res.status(400).json({ error: 'No puedes emparejarte con tu propia cuenta.' });
    }

    // Vincular bidireccionalmente en la tabla users
    await pool.query('UPDATE users SET partner_id = ? WHERE id = ?', [partnerId, userId]);
    await pool.query('UPDATE users SET partner_id = ? WHERE id = ?', [userId, partnerId]);
    await pool.query('DELETE FROM pairing_codes WHERE code = ?', [code]);

    res.json({ success: true, partnerId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. OBTENER INFORMACIÓN DE LA PAREJA (Requerido por la App Android)
app.get('/api/pair/partner', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'Falta el parámetro userId' });

  try {
    const [userRows] = await pool.query('SELECT partner_id FROM users WHERE id = ?', [userId]);
    if (userRows.length === 0 || !userRows[0].partner_id) {
      return res.json({ partner: null });
    }

    const partnerId = userRows[0].partner_id;
    const [partnerRows] = await pool.query('SELECT id, name, email FROM users WHERE id = ?', [partnerId]);
    if (partnerRows.length === 0) {
      return res.json({ partner: null });
    }

    res.json({
      partner: partnerRows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Desvincular pareja (opcional para cuando se requiera)
app.post('/api/pair/unlink', async (req, res) => {
  const { userId } = req.body;
  try {
    const [userRows] = await pool.query('SELECT partner_id FROM users WHERE id = ?', [userId]);
    if (userRows.length > 0 && userRows[0].partner_id) {
      const partnerId = userRows[0].partner_id;
      await pool.query('UPDATE users SET partner_id = NULL WHERE id = ?', [userId]);
      await pool.query('UPDATE users SET partner_id = NULL WHERE id = ?', [partnerId]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Finanzas API corriendo en el puerto ${PORT}`);
});
