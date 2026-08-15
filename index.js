const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>My Bonto App</title>
      <style>
        body { font-family: system-ui, sans-serif; max-width: 600px; margin: 80px auto; padding: 0 20px; color: #e0e0e0; background: #1a1a2e; }
        h1 { color: #00d4ff; }
        code { background: #16213e; padding: 2px 6px; border-radius: 4px; }
        a { color: #00d4ff; }
      </style>
    </head>
    <body>
      <h1>Hello from Bonto!</h1>
      <p>Edit <code>index.js</code> in the editor to change this page.</p>
      <p>Your changes will appear here automatically.</p>
      <p style="margin-top: 2rem; font-size: 0.75rem; opacity: 0.4;">Hosted on <a href="https://bonto.dev" style="color: inherit;">Bonto</a></p>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`);
});
