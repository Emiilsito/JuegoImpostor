const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sdalData = require('./sdal.json');

const app = express();
const server = http.createServer(app);

// 🔥 CONFIGURACIÓN PARA WEBSOCKETS PUROS
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  // ⛔️ Desactivamos polling, solo permitimos websockets
  transports: ['websocket'],
  allowEIO3: true
});

// Mantener el healthcheck para Railway
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

const lobbies = {};

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

const broadcastLobbies = () => {
  const listaPublica = Object.values(lobbies).map(l => ({
    id: l.id,
    numPlayers: l.players.length,
    maxPlayers: l.maxPlayers,
    status: l.status
  }));
  io.emit('all_lobbies_list', listaPublica);
};

function asignarRoles(lobby) {
  const palabras = Object.keys(sdalData);
  const palabraSecreta = palabras[Math.floor(Math.random() * palabras.length)].toUpperCase();
  
  const indices = shuffle(lobby.players.map((_, i) => i));
  const impostoresIndices = indices.slice(0, lobby.impostoresCount || 1);

  lobby.players.forEach((player, index) => {
    const esImpostor = impostoresIndices.includes(index);
    player.role = esImpostor ? 'impostor' : 'civil';
    player.word = esImpostor ? 'IMPOSTOR' : palabraSecreta;
    player.alive = true;
    player.ready = false;
  });
}

io.on('connection', (socket) => {
  console.log(`Conexión WS directa: ${socket.id}`);
  broadcastLobbies();

  socket.on('create_lobby', ({ hostName }) => {
    const lobbyId = Math.random().toString(36).substring(2, 6).toUpperCase();
    lobbies[lobbyId] = {
      id: lobbyId,
      hostId: socket.id,
      players: [{ id: socket.id, name: hostName, role: null, word: null, ready: false, alive: true }],
      status: 'waiting',
      maxPlayers: 8,
      impostoresCount: 1,
      votos: {}
    };
    socket.join(lobbyId);
    socket.emit('lobby_created', lobbies[lobbyId]);
    broadcastLobbies();
  });

  socket.on('join_lobby', ({ lobbyId, playerName }) => {
    const lobby = lobbies[lobbyId];
    if (lobby && lobby.status === 'waiting' && lobby.players.length < lobby.maxPlayers) {
      if (lobby.players.some(p => p.id === socket.id)) return;
      lobby.players.push({ id: socket.id, name: playerName, role: null, word: null, ready: false, alive: true });
      socket.join(lobbyId);
      socket.emit('joined_successfully', lobby);
      io.to(lobbyId).emit('lobby_updated', lobby);
      broadcastLobbies();
    }
  });

  socket.on('start_game', ({ lobbyId }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby || lobby.hostId !== socket.id) return;
    asignarRoles(lobby);
    lobby.status = 'playing';
    io.to(lobbyId).emit('game_started', lobby);
    broadcastLobbies();
  });

  socket.on('player_ready', ({ lobbyId }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;
    const player = lobby.players.find(p => p.id === socket.id);
    if (player) player.ready = true;

    const jugadoresVivos = lobby.players.filter(p => p.alive);
    if (jugadoresVivos.every(p => p.ready)) {
      lobby.timeLeft = 10;
      io.to(lobbyId).emit('start_voting_timer', { timeLeft: lobby.timeLeft });
      const timer = setInterval(() => {
        lobby.timeLeft--;
        io.to(lobbyId).emit('timer_update', lobby.timeLeft);
        if (lobby.timeLeft <= 0) {
          clearInterval(timer);
          procesarVotacion(lobbyId);
        }
      }, 1000);
    } else {
      io.to(lobbyId).emit('lobby_updated', lobby);
    }
  });

  socket.on('cast_vote', ({ lobbyId, votedId }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;
    lobby.votos[votedId] = (lobby.votos[votedId] || 0) + 1;
    io.to(lobbyId).emit('votes_update', { 
      voted: Object.values(lobby.votos).reduce((a, b) => a + b, 0), 
      total: lobby.players.filter(p => p.alive).length 
    });
  });

  function procesarVotacion(lobbyId) {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;
    let expulsadoId = Object.keys(lobby.votos).reduce((a, b) => lobby.votos[a] > lobby.votos[b] ? a : b, null);
    const expulsado = lobby.players.find(p => p.id === expulsadoId);
    if (expulsado) expulsado.alive = false;

    const resultado = {
      expulsadoNombre: expulsado ? expulsado.name : "Nadie",
      esImpostor: expulsado ? expulsado.role === 'impostor' : false,
      palabraCorrecta: lobby.players.find(p => p.role === 'civil')?.word || "",
      gameEnded: false,
      ganador: null
    };

    const civilesVivos = lobby.players.filter(p => p.alive && p.role === 'civil').length;
    const impostoresVivos = lobby.players.filter(p => p.alive && p.role === 'impostor').length;

    if (impostoresVivos === 0) { resultado.gameEnded = true; resultado.ganador = 'civiles'; }
    else if (impostoresVivos >= civilesVivos) { resultado.gameEnded = true; resultado.ganador = 'impostores'; }

    io.to(lobbyId).emit('voting_result', resultado);

    if (!resultado.gameEnded) {
      setTimeout(() => {
        lobby.votos = {};
        lobby.players.forEach(p => p.ready = false);
        io.to(lobbyId).emit('lobby_updated', lobby);
      }, 4000);
    } else {
      lobby.status = 'waiting';
      broadcastLobbies();
    }
  }

  socket.on('disconnect', () => {
    Object.keys(lobbies).forEach(id => {
      const lobby = lobbies[id];
      lobby.players = lobby.players.filter(p => p.id !== socket.id);
      if (lobby.players.length === 0) delete lobbies[id];
      else if (lobby.hostId === socket.id) lobby.hostId = lobby.players[0].id;
      io.to(id).emit('lobby_updated', lobby);
    });
    broadcastLobbies();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`>>> Servidor WS puro en puerto ${PORT}`);
});