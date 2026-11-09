// Utilidades compartidas por todas las páginas
const money = (n) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);

const PAGOS = { efectivo: '💵 Efectivo', tarjeta: '💳 Tarjeta', pse: '🏦 PSE' };
const ESTADOS = {
  por_confirmar: 'Por confirmar',
  pendiente: 'Pendiente',
  preparando: 'En preparación',
  listo: 'Listo para servir',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
};

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  // Sesión del jefe vencida o cerrada: volver al login (excepto en la propia página de login)
  if (res.status === 401 && data.code === 'NO_AUTH' && !location.pathname.startsWith('/login')) {
    location.href = `/login.html?next=${encodeURIComponent(location.pathname)}`;
  }
  if (!res.ok) throw new Error(data.error || 'Ocurrió un error. Intenta de nuevo.');
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function hora(iso) {
  return new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}

function haceCuanto(iso) {
  const min = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  return `hace ${Math.floor(min / 60)} h ${min % 60} min`;
}

let toastTimer;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// Sonido corto para avisar pedidos nuevos (sin archivos de audio)
let audioCtx;
function beep(veces = 2) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < veces; i++) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = 880;
      o.connect(g);
      g.connect(audioCtx.destination);
      const t = audioCtx.currentTime + i * 0.3;
      g.gain.setValueAtTime(0.25, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      o.start(t);
      o.stop(t + 0.25);
    }
  } catch {}
}
// Los navegadores sólo permiten sonido después de que el usuario toca la página
document.addEventListener('click', () => { if (audioCtx?.state === 'suspended') audioCtx.resume(); }, { once: false });

// Tarjeta de pedido usada por cocina y mesera
function orderCardHTML(o, acciones = '') {
  return `
    <div class="card order-card" data-id="${o.id}">
      <div class="row between">
        <div>
          <div class="mesa">Mesa ${o.table}</div>
          <div class="muted small">Pedido #${o.id} · ${hora(o.createdAt)} · <span class="tiempo" data-t="${o.createdAt}">${haceCuanto(o.createdAt)}</span></div>
        </div>
        <span class="badge st-${o.status}">${ESTADOS[o.status]}</span>
      </div>
      <ul>
        ${o.items.map((l) => `
          <li><span class="qty">${l.qty}×</span>${esc(l.emoji)} ${esc(l.name)}
          ${l.notes ? `<div class="muted small">↳ ${esc(l.notes)}</div>` : ''}</li>`).join('')}
      </ul>
      ${o.note ? `<div class="nota">📝 ${esc(o.note)}</div>` : ''}
      ${acciones}
    </div>`;
}

const ROLES_TXT = { jefe: '👑 Jefe', mesero: '🛎️ Mesero', cocinero: '👨‍🍳 Cocinero' };

// Nombre del usuario y botón "Cerrar sesión" en la barra superior de las pantallas del personal
async function barraSesion() {
  const barra = document.querySelector('.topbar');
  if (!barra) return null;
  try {
    const { user } = await api('/api/auth/me');
    const caja = document.createElement('div');
    caja.className = 'row';
    caja.innerHTML = `<span class="small muted">${esc(user.name)} · ${ROLES_TXT[user.role] || ''}</span>
      ${user.role === 'jefe' ? '<a class="btn btn-sm" href="/admin.html">Panel</a>' : ''}
      <button class="btn btn-sm" type="button">Cerrar sesión</button>`;
    caja.querySelector('button').onclick = async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
      location.href = '/login.html';
    };
    barra.appendChild(caja);
    return user;
  } catch {
    return null;
  }
}

// Refresca los "hace X min" cada 30 s
setInterval(() => {
  document.querySelectorAll('.tiempo').forEach((el) => (el.textContent = haceCuanto(el.dataset.t)));
}, 30000);
