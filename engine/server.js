import { createEngineServer } from './app.js';
import { runSession } from './session.js';
import { verifyTicket } from './ticket.js';

const PORT = 4300;

const { server } = createEngineServer({ verifyTicket, runSession });
server.listen(PORT, () => console.log(`robot-lab-engine en écoute sur :${PORT}`));
