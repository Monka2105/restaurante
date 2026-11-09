// Base de datos SQLite del restaurante (usa el SQLite que trae Node, sin instalar nada)
// Archivo: data/restaurante.db
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'restaurante.db');
const JSON_VIEJO = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// ---------- Esquema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  category    TEXT    NOT NULL DEFAULT 'General',
  price       INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),
  description TEXT    NOT NULL DEFAULT '',
  emoji       TEXT    NOT NULL DEFAULT '🍽️',
  stock       INTEGER NOT NULL DEFAULT 0,
  min_stock   INTEGER NOT NULL DEFAULT 5,
  active      INTEGER NOT NULL DEFAULT 1,
  sold_out    INTEGER NOT NULL DEFAULT 0
);

-- Cada vez que un mesero abre una mesa se crea una sesión; queda el historial
CREATE TABLE IF NOT EXISTS table_sessions (
  id        TEXT    PRIMARY KEY,
  table_no  INTEGER NOT NULL,
  opened_at TEXT    NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sesiones_abiertas ON table_sessions (table_no) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  table_no       INTEGER NOT NULL,
  session_id     TEXT REFERENCES table_sessions (id),
  total          INTEGER NOT NULL,
  payment_method TEXT    NOT NULL CHECK (payment_method IN ('efectivo', 'tarjeta', 'pse')),
  paid           INTEGER NOT NULL DEFAULT 0,
  note           TEXT    NOT NULL DEFAULT '',
  status         TEXT    NOT NULL CHECK (status IN ('por_confirmar', 'pendiente', 'preparando', 'listo', 'entregado', 'cancelado')),
  confirmed_at   TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_fecha ON orders (created_at);
CREATE INDEX IF NOT EXISTS idx_orders_sesion ON orders (session_id);

-- Se guarda nombre y precio del momento de la venta, aunque luego cambie el producto
CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  emoji      TEXT    NOT NULL DEFAULT '',
  price      INTEGER NOT NULL,
  qty        INTEGER NOT NULL CHECK (qty > 0),
  notes      TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items (order_id);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'mesero' CHECK (role IN ('jefe', 'mesero', 'cocinero')),
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL
);
`);

// Bases creadas antes de existir los roles mesero/cocinero: reconstruir la tabla users
// (SQLite no permite cambiar un CHECK; se sigue el procedimiento oficial de copiar y renombrar)
(function migrarRoles() {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()?.sql || '';
  if (sql.includes("'cocinero'")) return;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE users_nueva (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        name          TEXT    NOT NULL,
        password_hash TEXT    NOT NULL,
        role          TEXT    NOT NULL DEFAULT 'mesero' CHECK (role IN ('jefe', 'mesero', 'cocinero')),
        created_at    TEXT    NOT NULL
      );
      INSERT INTO users_nueva (id, username, name, password_hash, role, created_at)
        SELECT id, username, name, password_hash, role, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_nueva RENAME TO users;
    `);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
})();

// Ejecuta varias operaciones como una sola (si algo falla, no se guarda nada)
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- Datos iniciales / migración desde db.json ----------
const PRODUCTOS_EJEMPLO = [
  ['Hamburguesa clásica', 'Platos fuertes', 22000, 'Carne de res, queso, lechuga, tomate y papas.', '🍔', 30, 5],
  ['Bandeja paisa', 'Platos fuertes', 32000, 'Frijoles, arroz, chicharrón, carne molida, huevo, arepa y maduro.', '🍛', 20, 5],
  ['Pechuga a la plancha', 'Platos fuertes', 26000, 'Con ensalada y papa al vapor.', '🍗', 25, 5],
  ['Empanadas (x3)', 'Entradas', 9000, 'Con ají de la casa.', '🥟', 40, 10],
  ['Patacones con hogao', 'Entradas', 12000, 'Patacón crocante con hogao casero.', '🍌', 15, 5],
  ['Limonada de coco', 'Bebidas', 9000, 'Natural, preparada al momento.', '🥥', 50, 10],
  ['Gaseosa', 'Bebidas', 5000, 'Personal 400 ml.', '🥤', 60, 12],
  ['Postre de natas', 'Postres', 8000, 'Receta tradicional.', '🍮', 12, 4],
];

function inicializar() {
  const vacia = db.prepare('SELECT COUNT(*) AS n FROM settings').get().n === 0;
  if (!vacia) return;

  if (fs.existsSync(JSON_VIEJO)) {
    migrarDesdeJSON(JSON.parse(fs.readFileSync(JSON_VIEJO, 'utf8')));
    fs.renameSync(JSON_VIEJO, JSON_VIEJO + '.migrado');
    console.log('   ✔ Datos de data/db.json migrados a SQLite (el archivo viejo quedó como db.json.migrado)');
    return;
  }

  tx(() => {
    setSetting('restaurantName', 'Mi Restaurante');
    setSetting('tables', 10);
    const ins = db.prepare('INSERT INTO products (name, category, price, description, emoji, stock, min_stock) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const p of PRODUCTOS_EJEMPLO) ins.run(...p);
  });
}

function migrarDesdeJSON(viejo) {
  tx(() => {
    setSetting('restaurantName', viejo.settings?.restaurantName || 'Mi Restaurante');
    setSetting('tables', viejo.settings?.tables || 10);

    const insP = db.prepare(`INSERT INTO products (id, name, category, price, description, emoji, stock, min_stock, active, sold_out)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of viejo.products || []) {
      insP.run(p.id, p.name, p.category || 'General', p.price || 0, p.description || '', p.emoji || '🍽️',
        p.stock || 0, p.minStock ?? 5, p.active === false ? 0 : 1, p.soldOut ? 1 : 0);
    }

    // Sesiones de mesa: las abiertas se conservan; las de pedidos viejos se crean ya cerradas
    const insS = db.prepare('INSERT OR IGNORE INTO table_sessions (id, table_no, opened_at, closed_at) VALUES (?, ?, ?, ?)');
    for (const [mesa, s] of Object.entries(viejo.tableSessions || {})) {
      if (s.sessionId) insS.run(s.sessionId, Number(mesa), s.openedAt || new Date().toISOString(), s.open ? null : s.closedAt || new Date().toISOString());
    }

    const insO = db.prepare(`INSERT INTO orders (id, table_no, session_id, total, payment_method, paid, note, status, confirmed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insI = db.prepare('INSERT INTO order_items (order_id, product_id, name, emoji, price, qty, notes) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const o of viejo.orders || []) {
      if (o.sessionId) insS.run(o.sessionId, o.table, o.createdAt, o.updatedAt || o.createdAt);
      insO.run(o.id, o.table, o.sessionId || null, o.total, o.paymentMethod, o.paid ? 1 : 0, o.note || '',
        o.status, o.confirmedAt || null, o.createdAt, o.updatedAt || o.createdAt);
      for (const l of o.items || []) insI.run(o.id, l.productId, l.name, l.emoji || '', l.price, l.qty, l.notes || '');
    }
  });
}

// ---------- Ajustes ----------
function getSettings() {
  const out = { restaurantName: 'Mi Restaurante', tables: 10 };
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    out[key] = key === 'tables' ? Number(value) : value;
  }
  return out;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// ---------- Productos ----------
const aProducto = (r) => r && ({
  id: r.id, name: r.name, category: r.category, price: r.price, description: r.description, emoji: r.emoji,
  stock: r.stock, minStock: r.min_stock, active: !!r.active, soldOut: !!r.sold_out,
});
const COLS_PRODUCTO = { name: 'name', category: 'category', price: 'price', description: 'description', emoji: 'emoji', stock: 'stock', minStock: 'min_stock', active: 'active', soldOut: 'sold_out' };

function listProducts() {
  return db.prepare('SELECT * FROM products ORDER BY category, name').all().map(aProducto);
}
function getProduct(id) {
  return aProducto(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
}
function guardarCampos(data) {
  const cols = [], vals = [];
  for (const [k, v] of Object.entries(data)) {
    if (!COLS_PRODUCTO[k]) continue;
    cols.push(COLS_PRODUCTO[k]);
    vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
  }
  return { cols, vals };
}
function createProduct(data) {
  const { cols, vals } = guardarCampos(data);
  const r = db.prepare(`INSERT INTO products (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
  return getProduct(Number(r.lastInsertRowid));
}
function updateProduct(id, data) {
  const { cols, vals } = guardarCampos(data);
  if (cols.length) db.prepare(`UPDATE products SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...vals, id);
  return getProduct(id);
}
function deleteProduct(id) {
  return db.prepare('DELETE FROM products WHERE id = ?').run(id).changes > 0;
}
function cambiarStock(productId, delta) {
  db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(delta, productId);
}

// ---------- Sesiones de mesa ----------
function sesionAbierta(mesa) {
  return db.prepare('SELECT * FROM table_sessions WHERE table_no = ? AND closed_at IS NULL').get(mesa) || null;
}
function abrirSesion(mesa, id, ahora) {
  db.prepare('INSERT INTO table_sessions (id, table_no, opened_at) VALUES (?, ?, ?)').run(id, mesa, ahora);
}
function cerrarSesion(id, ahora) {
  db.prepare('UPDATE table_sessions SET closed_at = ? WHERE id = ?').run(ahora, id);
}

// ---------- Pedidos ----------
const itemsDe = db.prepare('SELECT product_id, name, emoji, price, qty, notes FROM order_items WHERE order_id = ? ORDER BY id');
function aPedido(r) {
  if (!r) return null;
  return {
    id: r.id, table: r.table_no, sessionId: r.session_id, total: r.total, paymentMethod: r.payment_method,
    paid: !!r.paid, note: r.note, status: r.status, confirmedAt: r.confirmed_at, createdAt: r.created_at, updatedAt: r.updated_at,
    items: itemsDe.all(r.id).map((i) => ({ productId: i.product_id, name: i.name, emoji: i.emoji, price: i.price, qty: i.qty, notes: i.notes })),
  };
}
function getOrder(id) {
  return aPedido(db.prepare('SELECT * FROM orders WHERE id = ?').get(id));
}
function listOrders({ active = false, since = null } = {}) {
  const where = [], vals = [];
  if (active) where.push("status NOT IN ('entregado', 'cancelado')");
  if (since) { where.push('created_at >= ?'); vals.push(since); }
  const sql = `SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`;
  return db.prepare(sql).all(...vals).map(aPedido);
}
function ordersBySession(sessionId) {
  return db.prepare('SELECT * FROM orders WHERE session_id = ? ORDER BY id').all(sessionId).map(aPedido);
}
function createOrder(o) {
  const r = db.prepare(`INSERT INTO orders (table_no, session_id, total, payment_method, paid, note, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`).run(o.table, o.sessionId, o.total, o.paymentMethod, o.note, o.status, o.createdAt, o.createdAt);
  const id = Number(r.lastInsertRowid);
  const ins = db.prepare('INSERT INTO order_items (order_id, product_id, name, emoji, price, qty, notes) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const l of o.items) ins.run(id, l.productId, l.name, l.emoji, l.price, l.qty, l.notes);
  return id;
}
function updateOrder(id, { status, paid, confirmedAt, updatedAt }) {
  const sets = ['updated_at = ?'], vals = [updatedAt];
  if (status !== undefined) { sets.push('status = ?'); vals.push(status); }
  if (paid !== undefined) { sets.push('paid = ?'); vals.push(paid ? 1 : 0); }
  if (confirmedAt !== undefined) { sets.push('confirmed_at = ?'); vals.push(confirmedAt); }
  db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
}
function sesionesAbiertasEnRango(since) {
  return db.prepare('SELECT COUNT(*) AS n FROM table_sessions WHERE opened_at >= ?').get(since || '').n;
}

// ---------- Usuarios y login ----------
const aUsuario = (r) => r && { id: r.id, username: r.username, name: r.name, role: r.role, createdAt: r.created_at };
function countUsers() { return db.prepare('SELECT COUNT(*) AS n FROM users').get().n; }
function listUsers() {
  return db.prepare("SELECT * FROM users ORDER BY CASE role WHEN 'jefe' THEN 0 WHEN 'mesero' THEN 1 ELSE 2 END, name").all().map(aUsuario);
}
function countJefes() { return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'jefe'").get().n; }
function setRole(id, role) { db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id); }
function userByUsername(username) { return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null; }
function userById(id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null; }
function createUser({ username, name, passwordHash, role = 'jefe' }) {
  const r = db.prepare('INSERT INTO users (username, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username, name, passwordHash, role, new Date().toISOString());
  return aUsuario(userById(Number(r.lastInsertRowid)));
}
function setPassword(id, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}
function deleteUser(id) { return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0; }

function createAuthSession(token, userId, expiresAt) {
  db.prepare('INSERT INTO auth_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, new Date().toISOString(), expiresAt);
}
function userByToken(token) {
  const r = db.prepare(`SELECT u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?`).get(token, new Date().toISOString());
  return aUsuario(r);
}
function deleteAuthSession(token) { db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token); }
function deleteUserSessions(userId, exceptToken = '') {
  db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token != ?').run(userId, exceptToken);
}
function purgeExpiredSessions() {
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

inicializar();

module.exports = {
  DB_FILE, tx,
  getSettings, setSetting,
  listProducts, getProduct, createProduct, updateProduct, deleteProduct, cambiarStock,
  sesionAbierta, abrirSesion, cerrarSesion,
  getOrder, listOrders, ordersBySession, createOrder, updateOrder, sesionesAbiertasEnRango,
  countUsers, countJefes, listUsers, userByUsername, userById, createUser, setPassword, setRole, deleteUser,
  createAuthSession, userByToken, deleteAuthSession, deleteUserSessions, purgeExpiredSessions,
};
