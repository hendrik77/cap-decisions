const http = require('node:http');

const noulRequest = { state: 'Refund me', questions: { answer: { type: 'noul', instructions: 'Refund?' } } };
const noulResult = {
  model: 'fake-model',
  answers: { answer: { type: 'noul', noul: 0.8 } },
  usage: { input_tokens: 3, output_tokens: 1 },
};

/**
 * Starts a local Jev-like HTTP server in the test process. The default handler records every request body in
 * `received` (with url and headers in `requests`) and answers with `noulResult`.
 */
async function startServer(handler) {
  const received = [];
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    received.push(body);
    requests.push({ url: request.url, headers: request.headers });
    if (server.handler) return server.handler(request, response, body);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(noulResult));
  });
  server.handler = handler;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/systemone`,
    received,
    requests,
    setHandler: (next) => {
      server.handler = next;
    },
    close: () => server.close(),
  };
}

module.exports = { startServer, noulRequest, noulResult };
