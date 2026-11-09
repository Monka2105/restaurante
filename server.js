// Servidor del sistema de pedidos por QR
// Express sirve las páginas y la API; Socket.IO avisa en tiempo real a cocina, meseros y jefe.
// Los datos se guardan en SQLite (ver db.js).
const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const db = require('./db');

const PORT = process.env.PORT || 3000;

// Flujo: por_confirmar (lo revisa el mesero) -> pendiente (cocina) -> preparando -> listo -> entregado
const ESTADOS = ['por_confirmar', 'pendiente', 'preparando', 'listo', 'entregado', 'cancelado'];
const METODOS_PAGO = ['efectivo', 'tarjeta', 'pse'];
const DURACION_LOGIN_MS = 7 * 24 * 60 * 60 * 1000; // la sesión dura 7 días
const ROLES = ['jefe', 'mesero', 'cocinero'];
// Todo el personal inicia sesión; sólo el jefe crea las cuentas. Cada rol tiene su pantalla.
const INICIO_ROL = { jefe: '/admin.html', mesero: '/mesera.html', cocinero: '/cocina.html' };
// Cada pantalla es sólo de su rol: si entra otro rol, se le pide iniciar sesión con la cuenta correcta
const PAGINAS = {
  '/admin.html': ['jefe'],
  '/mesera.html': ['mesero'],
  '/cocina.html': ['cocinero'],
};
// Qué cambios de estado de un pedido puede hacer cada rol
const PERMISOS_ESTADO = {
  jefe: ESTADOS,
  mesero: ['pendiente', 'entregado', 'cancelado'], // confirmar, entregar en la mesa, rechazar/cancelar
  cocinero: ['preparando', 'listo', 'cancelado'],
};

// ---------- Utilidades ----------
function ipLocal() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}
const BASE_URL = process.env.BASE_URL || `http://${ipLocal()}:${PORT}`;

function productoPublico(p) {
  const { stock, minStock, soldOut, ...resto } = p;
  // Se muestra agotado si no hay stock o si el jefe lo marcó manualmente
  return { ...resto, available: stock > 0 && !soldOut };
}

function texto(v, max = 200) {
  return String(v ?? '').trim().slice(0, max);
}

const ahoraISO = () => new Date().toISOString();
const numMesas = () => db.getSettings().tables;
const mesaValida = (mesa) => Number.isInteger(mesa) && mesa >= 1 && mesa <= numMesas();

function devolverInventario(order) {
  for (const l of order.items) db.cambiarStock(l.productId, l.qty);
}

function resumenMesa(mesa) {
  const s = db.sesionAbierta(mesa);
  const sesion = s ? db.ordersBySession(s.id).filter((o) => o.status !== 'cancelado') : [];
  const pedidos = sesion.filter((o) => o.status !== 'por_confirmar'); // sólo los confirmados cuentan en la cuenta
  return {
    table: mesa,
    open: !!s,
    openedAt: s?.opened_at || null,
    orders: pedidos.length,
    total: pedidos.reduce((t, o) => t + o.total, 0),
    unpaid: pedidos.filter((o) => !o.paid).reduce((t, o) => t + o.total, 0),
    active: pedidos.filter((o) => o.status !== 'entregado').length,
    toConfirm: sesion.length - pedidos.length,
  };
}

// ---------- Contraseñas y sesiones de login ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verificarPassword(password, guardado) {
  const [, saltHex, hashHex] = String(guardado).split('$');
  if (!saltHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, 'hex');
  const real = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), esperado.length);
  return crypto.timingSafeEqual(esperado, real);
}
function validarPassword(p) {
  if (typeof p !== 'string' || p.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (p.length > 128) return 'La contraseña es demasiado larga.';
  return null;
}
function validarUsuario(u) {
  return /^[a-zA-Z0-9._-]{3,30}$/.test(u || '') ? null : 'El usuario debe tener de 3 a 30 letras, números, punto, guion o guion bajo.';
}

function leerCookie(req, nombre) {
  for (const parte of ((req.headers && req.headers.cookie) || '').split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nombre) return decodeURIComponent(v.join('='));
  }
  return null;
}
function iniciarSesion(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.createAuthSession(token, userId, new Date(Date.now() + DURACION_LOGIN_MS).toISOString());
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DURACION_LOGIN_MS / 1000}`);
  return token;
}
function usuarioActual(req) {
  const token = leerCookie(req, 'sid');
  return token ? db.userByToken(token) : null;
}

// Protege la API según el rol
function conRol(...roles) {
  return (req, res, next) => {
    const user = usuarioActual(req);
    if (!user) return res.status(401).json({ error: 'Inicia sesión para continuar.', code: 'NO_AUTH' });
    if (!roles.includes(user.role)) return res.status(403).json({ error: 'Tu rol no tiene permiso para hacer esto.', code: 'SIN_PERMISO' });
    req.user = user;
    next();
  };
}
const soloJefe = conRol('jefe');
const meseros = conRol('jefe', 'mesero');
const personal = conRol(...ROLES);

// Límite de intentos de login: 5 fallos seguidos bloquean esa IP por 5 minutos
const intentos = new Map();
function bloqueado(ip) {
  const r = intentos.get(ip);
  return r && r.hasta > Date.now();
}
function registrarFallo(ip) {
  const r = intentos.get(ip) || { fallos: 0, hasta: 0 };
  r.fallos += 1;
  if (r.fallos >= 5) { r.hasta = Date.now() + 5 * 60 * 1000; r.fallos = 0; }
  intentos.set(ip, r);
}

// ---------- App ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Tiempo real: el personal con sesión entra a la sala "staff"; el cliente sólo a la de su mesa
io.on('connection', (socket) => {
  if (usuarioActual(socket.request)) socket.join('staff');
  const mesa = Number(socket.handshake.query.mesa);
  if (mesaValida(mesa)) socket.join(`mesa:${mesa}`);
});
const avisarPersonal = (evento, data) => io.to('staff').emit(evento, data);
const avisarMesa = (mesa, evento, data) => io.to('staff').to(`mesa:${mesa}`).emit(evento, data);
const avisarPedido = (o) => avisarMesa(o.table, 'order:updated', o);
const avisarEstadoMesa = (mesa) => avisarMesa(mesa, 'table:updated', resumenMesa(mesa));

app.use(express.json({ limit: '100kb' }));

// Las pantallas del personal sólo se entregan a quien tenga el rol correspondiente
for (const [pagina, roles] of Object.entries(PAGINAS)) {
  app.get([pagina, pagina.replace('.html', '')], (req, res) => {
    const user = usuarioActual(req);
    // Sin sesión o con la sesión de otro rol: al login, que ofrece cambiar de cuenta
    if (!user || !roles.includes(user.role)) return res.redirect(`/login.html?next=${pagina}`);
    res.sendFile(path.join(__dirname, 'public', pagina));
  });
}

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// ---------- Login ----------
app.get('/api/auth/me', (req, res) => {
  const user = usuarioActual(req);
  if (!user) return res.status(401).json({ error: 'Sin sesión.', code: 'NO_AUTH', needsSetup: db.countUsers() === 0 });
  res.json({ user, home: INICIO_ROL[user.role] });
});

// Primera vez: se crea la cuenta del jefe (sólo funciona si aún no hay usuarios)
app.post('/api/auth/setup', (req, res) => {
  if (db.countUsers() > 0) return res.status(409).json({ error: 'La cuenta del jefe ya fue creada. Inicia sesión.' });
  const { name, username, password } = req.body || {};
  const err = (!texto(name, 60) && 'Escribe tu nombre.') || validarUsuario(username) || validarPassword(password);
  if (err) return res.status(400).json({ error: err });
  const user = db.createUser({ username, name: texto(name, 60), passwordHash: hashPassword(password), role: 'jefe' });
  iniciarSesion(res, user.id);
  res.status(201).json({ user, home: '/admin.html' });
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip;
  if (bloqueado(ip)) return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera 5 minutos e inténtalo de nuevo.' });
  const { username, password } = req.body || {};
  const row = db.userByUsername(String(username || ''));
  if (!row || !verificarPassword(String(password || ''), row.password_hash)) {
    registrarFallo(ip);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  intentos.delete(ip);
  iniciarSesion(res, row.id);
  res.json({ user: { id: row.id, username: row.username, name: row.name, role: row.role }, home: INICIO_ROL[row.role] });
});

app.post('/api/auth/logout', (req, res) => {
  const token = leerCookie(req, 'sid');
  if (token) db.deleteAuthSession(token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.status(204).end();
});

app.post('/api/auth/password', personal, (req, res) => {
  const { current, password } = req.body || {};
  const row = db.userById(req.user.id);
  if (!verificarPassword(String(current || ''), row.password_hash)) return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
  const err = validarPassword(password);
  if (err) return res.status(400).json({ error: err });
  db.setPassword(row.id, hashPassword(password));
  db.deleteUserSessions(row.id, leerCookie(req, 'sid')); // cierra la sesión en los demás dispositivos
  res.json({ ok: true });
});

// ---------- Usuarios (sólo jefe) ----------
app.get('/api/users', soloJefe, (req, res) => res.json(db.listUsers()));

app.post('/api/users', soloJefe, (req, res) => {
  const { name, username, password, role } = req.body || {};
  const nombre = texto(name, 60);
  if (!nombre) return res.status(400).json({ error: 'Escribe el nombre.' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Elige el rol: jefe, mesero o cocinero.' });

  const err = validarUsuario(username) || validarPassword(password);
  if (err) return res.status(400).json({ error: err });
  if (db.userByUsername(username)) return res.status(409).json({ error: 'Ese usuario ya existe.' });
  res.status(201).json(db.createUser({ username, name: nombre, passwordHash: hashPassword(password), role }));
});

// Cambiar el rol de una persona o restablecerle la contraseña
app.patch('/api/users/:id', soloJefe, (req, res) => {
  const id = Number(req.params.id);
  const user = db.userById(id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });
  const { role, password } = req.body || {};

  if (role !== undefined) {
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Rol no válido.' });
    if (id === req.user.id && role !== 'jefe') return res.status(400).json({ error: 'No puedes quitarte a ti mismo el rol de jefe.' });
    db.setRole(id, role); // aplica de inmediato: el rol se lee en cada petición
  }
  if (password !== undefined) {
    const err = validarPassword(password);
    if (err) return res.status(400).json({ error: err });
    db.setPassword(id, hashPassword(password));
    if (id !== req.user.id) db.deleteUserSessions(id); // debe entrar de nuevo con la contraseña nueva
  }
  res.json(db.listUsers().find((u) => u.id === id));
});

app.delete('/api/users/:id', soloJefe, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'No puedes borrar tu propia cuenta.' });
  if (!db.deleteUser(id)) return res.status(404).json({ error: 'Usuario no encontrado.' });
  res.status(204).end();
});

// ---------- Público (cliente) ----------
app.get('/api/config', (req, res) => {
  res.json({ ...db.getSettings(), baseUrl: BASE_URL });
});

// Menú para el cliente (sin datos de inventario)
app.get('/api/menu', (req, res) => {
  res.json(db.listProducts().filter((p) => p.active).map(productoPublico));
});

// Crear pedido (cliente)
app.post('/api/orders', (req, res) => {
  const { table, items, paymentMethod, note, sessionId } = req.body || {};
  const mesa = Number(table);

  if (!mesaValida(mesa)) {
    return res.status(400).json({ error: 'Mesa no válida. Escanea de nuevo el código QR de tu mesa.' });
  }
  const sesion = db.sesionAbierta(mesa);
  if (!sesion) {
    return res.status(423).json({ error: 'Tu mesa no está activa, por favor llama al mesero.', code: 'MESA_CERRADA' });
  }
  if (sessionId !== sesion.id) {
    // El cliente tenía abierta una sesión anterior de esta mesa (ya cerrada)
    return res.status(409).json({ error: 'Tu sesión de mesa cambió. Recarga la página para continuar.', code: 'SESION_CAMBIO' });
  }
  // Un solo pedido esperando confirmación por mesa: evita llenar la lista del mesero con pedidos falsos
  if (db.ordersBySession(sesion.id).some((o) => o.status === 'por_confirmar')) {
    return res.status(409).json({ error: 'Ya tienes un pedido esperando la confirmación del mesero. Espera a que lo revise.', code: 'ESPERANDO_CONFIRMACION' });
  }
  if (!METODOS_PAGO.includes(paymentMethod)) {
    return res.status(400).json({ error: 'Selecciona un método de pago.' });
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
    return res.status(400).json({ error: 'El pedido está vacío.' });
  }

  let id;
  try {
    id = db.tx(() => {
      // Agrupar cantidades por producto y validar stock antes de descontar nada
      const lineas = [];
      for (const it of items) {
        const prod = db.getProduct(Number(it.productId));
        const qty = Number(it.qty);
        if (!prod || !prod.active) throw { status: 400, error: 'Uno de los productos ya no está disponible.' };
        if (prod.soldOut) throw { status: 409, error: `${prod.name} está agotado. Quítalo de tu pedido.` };
        if (!Number.isInteger(qty) || qty < 1 || qty > 50) throw { status: 400, error: `Cantidad no válida para ${prod.name}.` };
        const notes = texto(it.notes, 120);
        const existente = lineas.find((l) => l.productId === prod.id && l.notes === notes);
        if (existente) existente.qty += qty;
        else lineas.push({ productId: prod.id, name: prod.name, emoji: prod.emoji, price: prod.price, qty, notes });
      }

      const totalPorProducto = {};
      for (const l of lineas) totalPorProducto[l.productId] = (totalPorProducto[l.productId] || 0) + l.qty;
      for (const [pid, qty] of Object.entries(totalPorProducto)) {
        const prod = db.getProduct(Number(pid));
        if (prod.stock < qty) throw { status: 409, error: `Solo quedan ${prod.stock} unidades de ${prod.name}.` };
      }
      for (const [pid, qty] of Object.entries(totalPorProducto)) db.cambiarStock(Number(pid), -qty);

      return db.createOrder({
        table: mesa,
        sessionId: sesion.id,
        items: lineas,
        total: lineas.reduce((s, l) => s + l.price * l.qty, 0),
        paymentMethod,
        note: texto(note, 300),
        status: 'por_confirmar', // el mesero debe verificarlo antes de que llegue a cocina
        createdAt: ahoraISO(),
      });
    });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.error });
    throw e;
  }

  const order = db.getOrder(id);
  avisarPersonal('order:new', order);
  io.emit('inventory:changed');
  avisarEstadoMesa(mesa);
  res.status(201).json(order);
});

// Consultar un pedido (el cliente sigue su estado)
app.get('/api/orders/:id', (req, res) => {
  const order = db.getOrder(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado.' });
  res.json(order);
});

// ---------- Mesas: estado, apertura y cierre ----------
app.get('/api/tables/:table/status', (req, res) => {
  const mesa = Number(req.params.table);
  if (!mesaValida(mesa)) return res.status(404).json({ error: 'Mesa no válida.' });
  const s = db.sesionAbierta(mesa);
  res.json({ table: mesa, open: !!s, sessionId: s ? s.id : null });
});

app.get('/api/tables', meseros, (req, res) => {
  res.json(Array.from({ length: numMesas() }, (_, i) => resumenMesa(i + 1)));
});

app.post('/api/tables/:table/open', meseros, (req, res) => {
  const mesa = Number(req.params.table);
  if (!mesaValida(mesa)) return res.status(404).json({ error: 'Mesa no válida.' });
  if (db.sesionAbierta(mesa)) return res.status(409).json({ error: `La mesa ${mesa} ya está abierta.` });
  db.abrirSesion(mesa, crypto.randomUUID(), ahoraISO());
  avisarEstadoMesa(mesa);
  res.json(resumenMesa(mesa));
});

app.post('/api/tables/:table/close', meseros, (req, res) => {
  const mesa = Number(req.params.table);
  if (!mesaValida(mesa)) return res.status(404).json({ error: 'Mesa no válida.' });
  const s = db.sesionAbierta(mesa);
  if (!s) return res.status(409).json({ error: `La mesa ${mesa} ya está cerrada.` });

  // No cerrar con cuentas pendientes salvo que el mesero lo confirme
  const pendiente = resumenMesa(mesa);
  if (pendiente.unpaid > 0 && !(req.body && req.body.force)) {
    return res.status(409).json({ error: `La mesa ${mesa} tiene pedidos sin pagar.`, code: 'CUENTA_PENDIENTE', unpaid: pendiente.unpaid });
  }

  // Los pedidos que nadie confirmó se anulan y devuelven su inventario
  const ahora = ahoraISO();
  const sinConfirmar = db.ordersBySession(s.id).filter((o) => o.status === 'por_confirmar');
  db.tx(() => {
    for (const o of sinConfirmar) {
      devolverInventario(o);
      db.updateOrder(o.id, { status: 'cancelado', updatedAt: ahora });
    }
    db.cerrarSesion(s.id, ahora);
  });
  sinConfirmar.forEach((o) => avisarPedido(db.getOrder(o.id)));
  if (sinConfirmar.length) io.emit('inventory:changed');
  avisarEstadoMesa(mesa);
  res.json(resumenMesa(mesa));
});

// ---------- Pedidos (cocina / meseros / jefe) ----------
function inicioDeHoy() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

app.get('/api/orders', personal, (req, res) => {
  res.json(db.listOrders({
    active: req.query.active === '1',
    since: req.query.today === '1' ? inicioDeHoy() : null,
  }));
});

app.patch('/api/orders/:id', personal, (req, res) => {
  const order = db.getOrder(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado.' });
  const { status, paid } = req.body || {};
  const cambios = { updatedAt: ahoraISO() };
  const rol = req.user.role;
  const sinPermiso = (error = 'Tu rol no puede poner el pedido en ese estado.') => res.status(403).json({ error, code: 'SIN_PERMISO' });

  if (status !== undefined) {
    if (!ESTADOS.includes(status)) return res.status(400).json({ error: 'Estado no válido.' });
    if (!PERMISOS_ESTADO[rol].includes(status)) return sinPermiso();
    // El mesero sólo usa "pendiente" para confirmar un pedido nuevo
    if (rol === 'mesero' && status === 'pendiente' && order.status !== 'por_confirmar') return sinPermiso();
    if (rol === 'cocinero' && order.status === 'por_confirmar') return sinPermiso('Este pedido aún no lo ha confirmado el mesero.');
    if (status === 'por_confirmar' && order.status !== 'por_confirmar') {
      return res.status(400).json({ error: 'Un pedido ya confirmado no puede volver a "por confirmar".' });
    }
    // Un pedido sin confirmar sólo puede ser aprobado (pasa a cocina) o rechazado
    if (order.status === 'por_confirmar' && !['por_confirmar', 'pendiente', 'cancelado'].includes(status)) {
      return res.status(409).json({ error: 'El mesero debe confirmar este pedido antes de prepararlo.' });
    }
    if (order.status === 'por_confirmar' && status === 'pendiente') cambios.confirmedAt = cambios.updatedAt;
    cambios.status = status;
  }
  if (paid !== undefined) {
    if (rol === 'cocinero') return sinPermiso('El cobro lo hace el mesero.');
    if (order.status === 'por_confirmar') return res.status(409).json({ error: 'Confirma el pedido antes de cobrarlo.' });
    cambios.paid = Boolean(paid);
  }

  const devolver = status === 'cancelado' && order.status !== 'cancelado';
  db.tx(() => {
    if (devolver) devolverInventario(order); // si se cancela/rechaza, vuelve al inventario
    db.updateOrder(order.id, cambios);
  });

  const actualizado = db.getOrder(order.id);
  if (devolver) io.emit('inventory:changed');
  avisarPedido(actualizado);
  if (mesaValida(actualizado.table)) avisarEstadoMesa(actualizado.table);
  res.json(actualizado);
});

// ---------- Productos / inventario (sólo jefe) ----------
function validarProducto(body, parcial = false) {
  const out = {};
  if (!parcial || body.name !== undefined) {
    out.name = texto(body.name, 80);
    if (!out.name) return { error: 'El nombre es obligatorio.' };
  }
  if (!parcial || body.category !== undefined) out.category = texto(body.category, 40) || 'General';
  if (!parcial || body.description !== undefined) out.description = texto(body.description, 200);
  if (!parcial || body.emoji !== undefined) out.emoji = texto(body.emoji, 8) || '🍽️';
  for (const campo of ['price', 'stock', 'minStock']) {
    if (!parcial || body[campo] !== undefined) {
      const n = Number(body[campo] ?? 0);
      if (!Number.isFinite(n) || n < 0) return { error: `Valor no válido en ${campo}.` };
      out[campo] = Math.round(n);
    }
  }
  if (body.active !== undefined) out.active = Boolean(body.active);
  if (body.soldOut !== undefined) out.soldOut = Boolean(body.soldOut);
  return { data: out };
}

app.get('/api/products', soloJefe, (req, res) => res.json(db.listProducts()));

app.post('/api/products', soloJefe, (req, res) => {
  const { error, data } = validarProducto(req.body || {});
  if (error) return res.status(400).json({ error });
  const prod = db.createProduct(data);
  io.emit('inventory:changed');
  res.status(201).json(prod);
});

app.put('/api/products/:id', soloJefe, (req, res) => {
  const id = Number(req.params.id);
  if (!db.getProduct(id)) return res.status(404).json({ error: 'Producto no encontrado.' });
  const { error, data } = validarProducto(req.body || {}, true);
  if (error) return res.status(400).json({ error });
  const prod = db.updateProduct(id, data);
  io.emit('inventory:changed');
  res.json(prod);
});

app.delete('/api/products/:id', soloJefe, (req, res) => {
  if (!db.deleteProduct(Number(req.params.id))) return res.status(404).json({ error: 'Producto no encontrado.' });
  io.emit('inventory:changed');
  res.status(204).end();
});

// ---------- Estadísticas de ventas (sólo jefe) ----------
const diaLocal = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

app.get('/api/stats', soloJefe, (req, res) => {
  const desde = req.query.from ? new Date(req.query.from) : null;
  const since = desde && !isNaN(desde) ? desde.toISOString() : null;
  const enRango = db.listOrders({ since });
  const validos = enRango.filter((o) => !['cancelado', 'por_confirmar'].includes(o.status));

  const porProducto = {};
  const porPago = { efectivo: 0, tarjeta: 0, pse: 0 };
  const porHora = Array(24).fill(0);
  const porDia = {};

  for (const o of validos) {
    porPago[o.paymentMethod] += o.total;
    porHora[new Date(o.createdAt).getHours()] += o.total;
    const d = (porDia[diaLocal(o.createdAt)] ||= { day: diaLocal(o.createdAt), orders: 0, revenue: 0 });
    d.orders += 1;
    d.revenue += o.total;
    for (const l of o.items) {
      const p = (porProducto[l.productId] ||= { productId: l.productId, name: l.name, emoji: l.emoji, qty: 0, revenue: 0 });
      p.qty += l.qty;
      p.revenue += l.qty * l.price;
    }
  }

  res.json({
    orders: validos.length,
    revenue: validos.reduce((s, o) => s + o.total, 0),
    collected: validos.filter((o) => o.paid).reduce((s, o) => s + o.total, 0),
    cancelled: enRango.filter((o) => o.status === 'cancelado').length,
    tablesServed: db.sesionesAbiertasEnRango(since),
    byProduct: Object.values(porProducto).sort((a, b) => b.qty - a.qty),
    byPayment: porPago,
    byHour: porHora,
    byDay: Object.values(porDia).sort((a, b) => a.day.localeCompare(b.day)),
    lowStock: db.listProducts().filter((p) => p.active && p.stock <= p.minStock),
  });
});

// ---------- Ajustes (sólo jefe) ----------
app.put('/api/settings', soloJefe, (req, res) => {
  const { restaurantName, tables } = req.body || {};
  if (restaurantName !== undefined && texto(restaurantName, 60)) db.setSetting('restaurantName', texto(restaurantName, 60));
  if (tables !== undefined) {
    const n = Number(tables);
    if (!Number.isInteger(n) || n < 1 || n > 200) return res.status(400).json({ error: 'Número de mesas no válido (1-200).' });
    db.setSetting('tables', n);
  }
  res.json(db.getSettings());
});

// ---------- Código QR por mesa ----------
app.get('/api/qr/:table', async (req, res) => {
  const mesa = Number(req.params.table);
  if (!mesaValida(mesa)) return res.status(404).end();
  const url = `${BASE_URL}/menu.html?mesa=${mesa}`;
  res.type('png').send(await QRCode.toBuffer(url, { width: 400, margin: 2 }));
});

// Errores no previstos: responder JSON en vez de la página de error de Express
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// Limpieza de sesiones de login vencidas cada hora
setInterval(() => db.purgeExpiredSessions(), 60 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log('\n🍽️  Sistema de pedidos QR funcionando\n');
  console.log(`   Inicio:      http://localhost:${PORT}`);
  console.log(`   Desde el celular (misma red WiFi): ${BASE_URL}`);
  console.log(`   Base de datos: ${db.DB_FILE}`);
  if (db.countUsers() === 0) console.log(`\n   👉 Crea la cuenta del jefe en: http://localhost:${PORT}/login.html`);
  console.log('');
});
