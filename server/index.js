const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sdalData = require('./sdal.json');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.status(200).send('Servidor Operativo'));

const lobbies = {};

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

const broadcastLobbies = () => {
  const lista = Object.values(lobbies).map(l => ({
    id: l.id, numPlayers: l.players.length, status: l.status
  }));
  io.emit('all_lobbies_list', lista);
};

function asignarRoles(lobby) {
  const palabras = Object.keys(sdalData);
  const palabraSecreta = palabras[Math.floor(Math.random() * palabras.length)].toUpperCase();
  const indices = shuffle(lobby.players.map((_, i) => i));
  const impostoresIndices = indices.slice(0, lobby.impostoresCount || 1);

  lobby.players.forEach((player, index) => {
    player.role = impostoresIndices.includes(index) ? 'impostor' : 'civil';
    player.word = player.role === 'impostor' ? 'IMPOSTOR' : palabraSecreta;
    player.alive = true;
    player.ready = false;
  });
}

io.on('connection', (socket) => {
  broadcastLobbies();

  socket.on('create_lobby', ({ hostName }) => {
    const id = Math.random().toString(36).substring(2, 6).toUpperCase();
    lobbies[id] = {
      id, hostId: socket.id, status: 'waiting', impostoresCount: 1, votos: {},
      players: [{ id: socket.id, name: hostName, role: null, word: null, ready: false, alive: true }]
    };
    socket.join(id);
    socket.emit('lobby_created', lobbies[id]);
    broadcastLobbies();
  });

  socket.on('join_lobby', ({ lobbyId, playerName }) => {
    const lobby = lobbies[lobbyId];
    if (lobby && lobby.status === 'waiting') {
      lobby.players.push({ id: socket.id, name: playerName, role: null, word: null, ready: false, alive: true });
      socket.join(lobbyId);
      socket.emit('joined_successfully', lobby);
      io.to(lobbyId).emit('lobby_updated', lobby);
      broadcastLobbies();
    }
  });

  socket.on('set_impostores_count', ({ lobbyId, count }) => {
    const lobby = lobbies[lobbyId];
    if (lobby && lobby.hostId === socket.id) {
      lobby.impostoresCount = count;
      io.to(lobbyId).emit('lobby_updated', lobby);
    }
  });

  socket.on('start_game', ({ lobbyId }) => {
    const lobby = lobbies[lobbyId];
    if (lobby && lobby.hostId === socket.id) {
      asignarRoles(lobby);
      lobby.status = 'playing';
      io.to(lobbyId).emit('game_started', lobby);
      broadcastLobbies();
    }
  });

  socket.on('player_ready', ({ lobbyId }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;
    const p = lobby.players.find(x => x.id === socket.id);
    if (p) p.ready = true;

    const jugadoresVivos = lobby.players.filter(x => x.alive);
    if (jugadoresVivos.every(x => x.ready)) {
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

  socket.on('flip_coin', ({ lobbyId }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    const resultado = Math.random() < 0.5 ? 'CARA' : 'CRUZ';
    
    // Enviamos el resultado a todos en la sala
    io.to(lobbyId).emit('coin_result', { 
      resultado, 
      lanzador: lobby.players.find(p => p.id === socket.id)?.name 
    });
  });

  socket.on('cast_vote', ({ lobbyId, votedId }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;
    const votante = lobby.players.find(p => p.id === socket.id);
    if (!votante || !votante.alive) return; // No votan los muertos

    lobby.votos[votedId] = (lobby.votos[votedId] || 0) + 1;
    io.to(lobbyId).emit('votes_update', { 
      voted: Object.values(lobby.votos).reduce((a, b) => a + b, 0), 
      total: lobby.players.filter(x => x.alive).length 
    });
  });

  function procesarVotacion(lobbyId) {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    let expId = Object.keys(lobby.votos).reduce((a, b) => (lobby.votos[a] > (lobby.votos[b] || 0) ? a : b), null);
    const exp = lobby.players.find(x => x.id === expId);
    if (exp) exp.alive = false;

    const civVivos = lobby.players.filter(x => x.alive && x.role === 'civil').length;
    const impVivos = lobby.players.filter(x => x.alive && x.role === 'impostor').length;
    const fin = (impVivos === 0 || impVivos >= civVivos);

    const res = {
      expulsadoNombre: exp ? exp.name : "Nadie",
      esImpostor: exp?.role === 'impostor',
      palabraCorrecta: fin ? lobby.players.find(x => x.role === 'civil')?.word : "????", // Oculto si no es el fin
      gameEnded: fin,
      ganador: impVivos === 0 ? 'civiles' : (impVivos >= civVivos ? 'impostores' : null)
    };

    io.to(lobbyId).emit('voting_result', res);

    if (!fin) {
      setTimeout(() => {
        lobby.votos = {};
        lobby.players.forEach(p => p.ready = false);
        io.to(lobbyId).emit('game_started', lobby); 
      }, 4000);
    } else {
      lobby.status = 'waiting';
      lobby.players.forEach(p => { p.role = null; p.word = null; p.ready = false; p.alive = true; });
      broadcastLobbies();
    }
  }

  socket.on('disconnect', () => {
    Object.keys(lobbies).forEach(id => {
      const l = lobbies[id];
      l.players = l.players.filter(x => x.id !== socket.id);
      if (l.players.length === 0) delete lobbies[id];
      else if (l.hostId === socket.id) l.hostId = l.players[0].id;
      io.to(id).emit('lobby_updated', l);
    });
    broadcastLobbies();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Puerto ${PORT}`));