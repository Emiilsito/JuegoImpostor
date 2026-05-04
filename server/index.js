const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Carga de seguridad del JSON
let sdalData = {};
try {
  const jsonPath = path.join(__dirname, 'sdal.json');
  if (fs.existsSync(jsonPath)) {
    sdalData = require('./sdal.json');
  } else {
    console.error("CRÍTICO: No se encontró sdal.json. Usando datos de prueba.");
    sdalData = { "EJEMPLO": ["dato1", "dato2"] };
  }
} catch (err) {
  console.error("Error cargando sdal.json:", err);
}

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', online: true });
});

app.get('/', (req, res) => {
  res.send('Servidor Impostor Operativo');
});

const lobbies = {};

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
  const impostoresIndices = new Set(indices.slice(0, lobby.impostoresCount));

  lobby.players.forEach((player, index) => {
    const esImpostor = impostoresIndices.has(index);
    player.role = esImpostor ? 'impostor' : 'civil';
    player.word = esImpostor ? 'IMPOSTOR' : palabraSecreta;
    player.alive = true;
    player.ready = false;
  });
}

io.on('connection', (socket) => {
  console.log(`Usuario conectado: ${socket.id}`);
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
    } else {
      socket.emit('error_message', 'Sala llena o no encontrada');
    }
  });

  socket.on('set_impostores_count', ({ lobbyId, count }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby || lobby.hostId !== socket.id) return;
    const maxImpostores = Math.max(1, Math.floor((lobby.players.length - 1) / 2));
    lobby.impostoresCount = Math.min(Math.max(1, count), maxImpostores);
    io.to(lobbyId).emit('lobby_updated', lobby);
  });

  socket.on('start_game', ({ lobbyId }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby || lobby.hostId !== socket.id || lobby.players.length < 3) return;
    
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
      lobby.turnOrder = shuffle(jugadoresVivos.map(p => p.id));
      lobby.currentTurnIndex = 0;
      io.to(lobbyId).emit('start_turns', {
        turnOrder: lobby.turnOrder,
        currentTurnIndex: 0,
        players: lobby.players
      });
    } else {
      io.to(lobbyId).emit('lobby_updated', lobby);
    }
  });

  socket.on('next_turn', ({ lobbyId }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby || lobby.turnOrder[lobby.currentTurnIndex] !== socket.id) return;

    lobby.currentTurnIndex++;
    if (lobby.currentTurnIndex >= lobby.turnOrder.length) {
      lobby.timeLeft = 10;
      lobby.votos = {};
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
      io.to(lobbyId).emit('start_turns', {
        turnOrder: lobby.turnOrder,
        currentTurnIndex: lobby.currentTurnIndex,
        players: lobby.players
      });
    }
  });

  socket.on('cast_vote', ({ lobbyId, votedId }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;
    lobby.votos[votedId] = (lobby.votos[votedId] || 0) + 1;
    const votosEmitidos = Object.values(lobby.votos).reduce((a, b) => a + b, 0);
    io.to(lobbyId).emit('votes_update', { voted: votosEmitidos, total: lobby.players.filter(p => p.alive).length });
  });

  function procesarVotacion(lobbyId) {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    let expulsadoId = Object.keys(lobby.votos).reduce((a, b) => (lobby.votos[a] > lobby.votos[b] ? a : b), null);
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

    if (impostoresVivos === 0) {
      resultado.gameEnded = true;
      resultado.ganador = 'civiles';
    } else if (impostoresVivos >= civilesVivos) {
      resultado.gameEnded = true;
      resultado.ganador = 'impostores';
    }

    io.to(lobbyId).emit('voting_result', resultado);

    if (!resultado.gameEnded) {
      setTimeout(() => {
        lobby.votos = {};
        asignarRoles(lobby);
        io.to(lobbyId).emit('game_started', lobby);
      }, 4000);
    } else {
      lobby.status = 'waiting';
    }
  }

  socket.on('disconnect', () => {
    Object.keys(lobbies).forEach(id => {
      const lobby = lobbies[id];
      lobby.players = lobby.players.filter(p => p.id !== socket.id);
      if (lobby.players.length === 0) delete lobbies[id];
      else {
        if (lobby.hostId === socket.id) lobby.hostId = lobby.players[0].id;
        io.to(id).emit('lobby_updated', lobby);
      }
    });
    broadcastLobbies();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`>>> Servidor Impostor ejecutándose en puerto ${PORT}`);
});