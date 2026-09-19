const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { Server } = require('socket.io');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = 3000;
const SECRET = 'nakhodka_local_secret';

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(PUBLIC_DIR));

// ---------- Хранилище в памяти ----------
const users = [];
const media = [];
const comments = [];
const trackers = [];
let nextId = 1;

// ---------- Multer (загрузка файлов) ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ---------- Проверка токена ----------
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Неверный токен' });
  }
}

// ---------- Регистрация ----------
app.post('/api/register', async (req, res) => {
  const { email, phone, password, name } = req.body;
  if ((!email && !phone) || !password)
    return res.status(400).json({ error: 'Укажите email/телефон и пароль' });

  const exists = users.find(u => (email && u.email === email) || (phone && u.phone === phone));
  if (exists) return res.status(400).json({ error: 'Пользователь уже существует' });

  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: nextId++,
    email: email || null,
    phone: phone || null,
    name: name || email || phone,
    password: hash
  };
  users.push(user);

  const token = jwt.sign({ id: user.id, name: user.name }, SECRET, { expiresIn: '7d' });
  res.json({ token, name: user.name });
});

// ---------- Вход ----------
app.post('/api/login', async (req, res) => {
  const { login, password } = req.body;
  const user = users.find(u => u.email === login || u.phone === login);
  if (!user) return res.status(400).json({ error: 'Пользователь не найден' });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Неверный пароль' });

  const token = jwt.sign({ id: user.id, name: user.name }, SECRET, { expiresIn: '7d' });
  res.json({ token, name: user.name });
});

// ---------- Загрузка медиа ----------
app.post('/api/media', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  const { title, description, latitude, longitude } = req.body;

  const item = {
    id: nextId++,
    userId: req.user.id,
    user_name: req.user.name,
    type: req.file.mimetype.startsWith('video') ? 'video' : 'photo',
    filename: req.file.filename,
    title: title || 'Без названия',
    description: description || '',
    lat: latitude ? parseFloat(latitude) : null,
    lng: longitude ? parseFloat(longitude) : null,
    createdAt: new Date().toISOString(),
  };
  media.push(item);
  res.json(item);
});

// ---------- Лента ----------
app.get('/api/media', (req, res) => {
  const sorted = [...media].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(sorted);
});

// ---------- Комментарии ----------
app.get('/api/media/:id/comments', (req, res) => {
  res.json(comments.filter(c => c.mediaId === parseInt(req.params.id)));
});

app.post('/api/media/:id/comments', auth, (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Пустой комментарий' });

  const c = {
    id: nextId++,
    mediaId: parseInt(req.params.id),
    userId: req.user.id,
    user_name: req.user.name,
    text,
    createdAt: new Date().toISOString(),
  };
  comments.push(c);
  res.json(c);
});

// ---------- Трекеры ----------
app.get('/api/trackers', (req, res) => res.json(trackers));

app.post('/api/trackers', auth, (req, res) => {
  const { title, description, latitude, longitude } = req.body;
  if (!title || latitude == null || longitude == null)
    return res.status(400).json({ error: 'Заполните поля' });

  const t = {
    id: nextId++,
    userId: req.user.id,
    user_name: req.user.name,
    title,
    description: description || '',
    latitude: parseFloat(latitude),
    longitude: parseFloat(longitude),
    createdAt: new Date().toISOString(),
  };
  trackers.push(t);
  res.json(t);
});

// ---------- WebRTC signaling ----------
const streams = new Map();

io.on('connection', socket => {
  socket.on('stream:start', ({ roomId }) => {
    socket.join(roomId);
    streams.set(roomId, { owner: socket.id, viewers: new Set() });
    io.emit('stream:list', Array.from(streams.keys()));
  });

  socket.on('stream:join', ({ roomId }) => {
    socket.join(roomId);
    const s = streams.get(roomId);
    if (s) s.viewers.add(socket.id);
    io.to(roomId).emit('stream:viewer-joined', { viewerId: socket.id });
  });

  socket.on('stream:offer', ({ to, offer }) =>
    io.to(to).emit('stream:offer', { from: socket.id, offer })
  );
  socket.on('stream:answer', ({ to, answer }) =>
    io.to(to).emit('stream:answer', { from: socket.id, answer })
  );
  socket.on('stream:ice', ({ to, candidate }) =>
    io.to(to).emit('stream:ice', { from: socket.id, candidate })
  );
  socket.on('stream:end', ({ roomId }) => {
    streams.delete(roomId);
    io.to(roomId).emit('stream:ended');
    io.emit('stream:list', Array.from(streams.keys()));
  });

  socket.on('disconnect', () => {
    for (const [roomId, s] of streams) {
      if (s.owner === socket.id) {
        streams.delete(roomId);
        io.to(roomId).emit('stream:ended');
      } else {
        s.viewers.delete(socket.id);
      }
    }
    io.emit('stream:list', Array.from(streams.keys()));
  });
});

// ---------- Запуск ----------
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  🪼  НАХОДКА ЗАПУЩЕНА\n');
  console.log('  💻  Локально:      http://localhost:' + PORT);
  console.log('  📱  С телефона:    http://' + getLocalIP() + ':' + PORT);
  console.log('\n  ⏹️   Ctrl+C — остановить\n');
});

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}