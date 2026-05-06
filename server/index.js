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
// --- NUEVO: Objeto para rastrear expulsiones pendientes ---
const pendingExpulsions = {};

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

// --- NUEVO: Función auxiliar para ejecutar la expulsión física ---
function ejecutarExpulsionFisica(socketId) {
  Object.keys(lobbies).forEach(id => {
    const l = lobbies[id];
    l.players = l.players.filter(x => x.id !== socketId);
    if (l.players.length === 0) delete lobbies[id];
    else if (l.hostId === socketId && l.players.length > 0) l.hostId = l.players[0].id;
    io.to(id).emit('lobby_updated', l);
  });
  broadcastLobbies();
  delete pendingExpulsions[socketId];
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
    if (lobby) {
      // --- NUEVO: Lógica de Reconexión ---
      const existingPlayer = lobby.players.find(p => p.name === playerName);
      if (existingPlayer) {
        // Cancelar expulsión si estaba pendiente
        if (pendingExpulsions[existingPlayer.id]) {
          clearTimeout(pendingExpulsions[existingPlayer.id]);
          delete pendingExpulsions[existingPlayer.id];
        }
        // Actualizar el ID del socket al nuevo
        existingPlayer.id = socket.id;
        socket.join(lobbyId);
        
        // Si el juego ya está en curso, lo mandamos directo a jugar
        if (lobby.status === 'playing') {
          socket.emit('game_started', lobby);
        }
      } else if (lobby.status === 'waiting') {
        // Unirse normal si es una sala nueva
        lobby.players.push({ id: socket.id, name: playerName, role: null, word: null, ready: false, alive: true });
        socket.join(lobbyId);
      }
      
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
        // HEMOS QUITADO EL TIMER. Ahora pasamos directo a la fase de votación.
        lobby.votos = {};
        io.to(lobbyId).emit('start_voting_phase'); // Nueva señal sin tiempo
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
    
    io.to(lobbyId).emit('coin_result', { 
      resultado, 
      lanzador: lobby.players.find(p => p.id === socket.id)?.name 
    });
  });

  socket.on('cast_vote', ({ lobbyId, votedId }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;
    const votante = lobby.players.find(p => p.id === socket.id);
    if (!votante || !votante.alive) return;

    lobby.votos[votedId] = (lobby.votos[votedId] || 0) + 1;
    
    const numVotos = Object.values(lobby.votos).reduce((a, b) => a + b, 0);
    const numVivos = lobby.players.filter(x => x.alive).length;

    io.to(lobbyId).emit('votes_update', { 
      voted: numVotos, 
      total: numVivos 
    });

    // Si todos han votado, procesamos el resultado automáticamente
    if (numVotos >= numVivos) {
      procesarVotacion(lobbyId);
    }
  });

  // --- NUEVO: Botón de salida manual (Borrado instantáneo) ---
  socket.on('leave_lobby', () => {
    ejecutarExpulsionFisica(socket.id);
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
      palabraCorrecta: fin ? lobby.players.find(x => x.role === 'civil')?.word : "????",
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

  // --- MODIFICADO: Desconexión con retraso de 2 minutos ---
  socket.on('disconnect', () => {
    const socketId = socket.id;
    // Programamos la limpieza para dentro de 120 segundos (2 minutos)
    pendingExpulsions[socketId] = setTimeout(() => {
      ejecutarExpulsionFisica(socketId);
    }, 120000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Puerto ${PORT}`));