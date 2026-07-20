require('dotenv').config();
const express = require('express');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// ---------- Health check ----------
// Checks both app liveness AND real DB connectivity.
// Jenkins pipeline polls this after every deploy before deciding rollback.
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.status(200).json({
      status: 'healthy',
      app: 'up',
      database: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return res.status(503).json({
      status: 'unhealthy',
      app: 'up',
      database: 'disconnected',
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ---------- CRUD: Todos ----------

// Create
app.post('/todos', async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'title is required and must be a string' });
    }
    const todo = await prisma.todo.create({ data: { title } });
    return res.status(201).json(todo);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create todo', detail: err.message });
  }
});

// Read all
app.get('/todos', async (_req, res) => {
  try {
    const todos = await prisma.todo.findMany({ orderBy: { id: 'asc' } });
    return res.json(todos);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch todos', detail: err.message });
  }
});

// Read one
app.get('/todos/:id', async (req, res) => {
  try {
    const todo = await prisma.todo.findUnique({ where: { id: Number(req.params.id) } });
    if (!todo) return res.status(404).json({ error: 'Todo not found' });
    return res.json(todo);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch todo', detail: err.message });
  }
});

// Update
app.put('/todos/:id', async (req, res) => {
  try {
    const { title, done } = req.body;
    const todo = await prisma.todo.update({
      where: { id: Number(req.params.id) },
      data: {
        ...(title !== undefined && { title }),
        ...(done !== undefined && { done })
      }
    });
    return res.json(todo);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Todo not found' });
    return res.status(500).json({ error: 'Failed to update todo', detail: err.message });
  }
});

// Delete
app.delete('/todos/:id', async (req, res) => {
  try {
    await prisma.todo.delete({ where: { id: Number(req.params.id) } });
    return res.status(204).send();
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Todo not found' });
    return res.status(500).json({ error: 'Failed to delete todo', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Todos API listening on port ${PORT}`);
});

// Graceful shutdown - important so PM2 restarts don't leave hanging DB connections
process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
