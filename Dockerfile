# Demo-only hello-world service. CloudForge does not build or deploy
# this image in the current scaffold — it is here as a sample target.
FROM node:22-alpine

EXPOSE 8080

CMD ["node", "-e", "require('http').createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('hello from CloudForge sample\\n'); }).listen(process.env.PORT || 8080)"]
