const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const sdpTransform = require('sdp-transform');

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.text({ type: 'application/sdp' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const HTTP_PORT = process.env.PORT || 3000;

// Mediasoup workers and routers
let worker;
let router;
const producers = new Map();
const consumers = new Map();
const whipProducers = new Map(); // Store WHIP producers by resource ID

// Initialize Mediasoup
async function createMediasoupWorker() {
  worker = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort: 40000,
    rtcMaxPort: 49999
  });

  worker.on('died', () => {
    console.error('[Mediasoup] Worker died, exiting...');
    process.exit(1);
  });

  // Create router with audio and video codecs (OBS may send both)
  router = await worker.createRouter({
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
      },
      {
        kind: 'audio',
        mimeType: 'audio/multiopus',
        clockRate: 48000,
        channels: 6
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000
      },
      {
        kind: 'video',
        mimeType: 'video/VP9',
        clockRate: 90000
      },
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1
        }
      }
    ]
  });

  console.log('[Mediasoup] ✅ Worker and router created');
  return router;
}

// WHIP endpoint - accepts WHIP POST requests from OBS
app.post('/whip/:resourceId', async (req, res) => {
  try {
    const resourceId = req.params.resourceId;
    const sdpOffer = req.body;
    
    console.log('[WHIP] 📥 Incoming WHIP connection:', resourceId);
    console.log('[WHIP] SDP Offer length:', sdpOffer.length);
    
    // Parse SDP offer
    const offer = sdpTransform.parse(sdpOffer);
    console.log('[WHIP] Parsed SDP offer:', JSON.stringify(offer, null, 2));
    
    // Create WebRTC transport for WHIP
    const transport = await router.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp: null }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true
    });
    
    // Connect transport with DTLS parameters from offer
    // Note: In a full implementation, you'd extract DTLS fingerprint from SDP
    await transport.connect({
      dtlsParameters: {
        role: 'auto',
        fingerprints: []
      }
    });
    
    // Create producers for each media in the offer
    const producers = [];
    for (const media of offer.media || []) {
      if (media.type === 'audio' || media.type === 'video') {
        try {
          // Extract RTP parameters from SDP
          const rtpParameters = {
            codecs: [],
            headerExtensions: [],
            encodings: [],
            rtcp: {}
          };
          
          // Parse codecs from SDP
          if (media.rtp) {
            for (const rtp of media.rtp) {
              rtpParameters.codecs.push({
                mimeType: `${media.type}/${rtp.codec}`,
                clockRate: rtp.rate,
                channels: media.type === 'audio' ? (rtp.encoding || 2) : undefined
              });
            }
          }
          
          // Create producer
          const producer = await transport.produce({
            kind: media.type,
            rtpParameters
          });
          
          producers.push(producer);
          console.log(`[WHIP] Created ${media.type} producer:`, producer.id);
        } catch (error) {
          console.error(`[WHIP] Error creating ${media.type} producer:`, error);
        }
      }
    }
    
    // Store transport and producers
    const whipData = {
      transport,
      resourceId,
      producers
    };
    whipProducers.set(resourceId, whipData);
    
    // Create SDP answer
    const answer = {
      version: 0,
      origin: {
        username: '-',
        sessionId: Date.now(),
        sessionVersion: 2,
        netType: 'IN',
        ipVer: 4,
        address: '127.0.0.1'
      },
      name: '-',
      timing: { start: 0, stop: 0 },
      connection: { ip: '0.0.0.0', version: 4 },
      media: []
    };
    
    // Add media descriptions for each producer
    for (const producer of producers) {
      const media = {
        type: producer.kind,
        port: 9,
        protocol: 'UDP/TLS/RTP/SAVPF',
        payloads: '',
        rtp: [],
        fmtp: [],
        iceUfrag: transport.iceParameters.usernameFragment,
        icePwd: transport.iceParameters.password,
        fingerprint: {
          type: 'sha-256',
          hash: transport.dtlsParameters.fingerprints[0]?.value || ''
        },
        setup: 'actpass',
        connection: { ip: '0.0.0.0', version: 4 }
      };
      
      // Add codec information
      if (producer.rtpParameters.codecs) {
        const codec = producer.rtpParameters.codecs[0];
        media.rtp.push({
          payload: 96,
          codec: codec.mimeType.split('/')[1],
          rate: codec.clockRate
        });
        media.payloads = '96';
      }
      
      answer.media.push(media);
    }
    
    // Convert answer to SDP string
    const answerSdp = sdpTransform.write(answer);
    
    // Set WHIP response headers
    res.setHeader('Content-Type', 'application/sdp');
    res.setHeader('Location', `/whip/${resourceId}`);
    res.setHeader('ETag', `"${resourceId}"`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    res.status(201).send(answerSdp);
    
    console.log('[WHIP] ✅ WHIP connection established:', resourceId);
    console.log('[WHIP] Created', producers.length, 'producer(s)');
    
  } catch (error) {
    console.error('[WHIP] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// WHIP DELETE endpoint
app.delete('/whip/:resourceId', async (req, res) => {
  const resourceId = req.params.resourceId;
  const whipData = whipProducers.get(resourceId);
  
  if (whipData) {
    console.log('[WHIP] 🛑 Deleting WHIP resource:', resourceId);
    whipData.transport.close();
    whipProducers.delete(resourceId);
    res.status(200).send('OK');
  } else {
    res.status(404).send('Not Found');
  }
});

// WHIP OPTIONS endpoint (for CORS preflight)
app.options('/whip/:resourceId', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(200).send('OK');
});

// WebRTC signaling via Socket.IO
io.on('connection', (socket) => {
  console.log('[WebRTC] Client connected:', socket.id);

  socket.on('getRouterRtpCapabilities', async (callback) => {
    try {
      const rtpCapabilities = router.rtpCapabilities;
      callback({ rtpCapabilities });
    } catch (error) {
      console.error('[WebRTC] Error getting router capabilities:', error);
      callback({ error: error.message });
    }
  });

  socket.on('createTransport', async ({ type }, callback) => {
    try {
      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: '0.0.0.0', announcedIp: null }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true
      });

      transport.on('dtlsstatechange', (dtlsState) => {
        if (dtlsState === 'closed') {
          transport.close();
        }
      });

      transport.on('close', () => {
        console.log('[WebRTC] Transport closed');
      });

      const { id, iceParameters, iceCandidates, dtlsParameters } = transport;

      callback({
        params: {
          id,
          iceParameters,
          iceCandidates,
          dtlsParameters
        }
      });

      socket.on('connect-transport', async ({ transportId, dtlsParameters }, callback) => {
        const transport = router.getTransport(transportId);
        await transport.connect({ dtlsParameters });
        callback({});
      });

      socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
        const transport = router.getTransport(transportId);
        const producer = await transport.produce({ kind, rtpParameters });
        producers.set(socket.id, producer);

        producer.on('transportclose', () => {
          console.log('[WebRTC] Producer transport closed');
          producers.delete(socket.id);
        });

        callback({ id: producer.id });
      });

      socket.on('getProducers', (callback) => {
        // Get all active producers (from WHIP or other sources)
        const producerList = [];
        
        // Add Socket.IO producers
        producers.forEach((producer, socketId) => {
          producerList.push({
            id: producer.id,
            kind: producer.kind,
            source: 'socket'
          });
        });
        
        // Add WHIP producers
        whipProducers.forEach((whipData, resourceId) => {
          whipData.producers.forEach(producer => {
            producerList.push({
              id: producer.id,
              kind: producer.kind,
              source: 'whip',
              resourceId
            });
          });
        });
        
        callback({ producers: producerList });
      });

      socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
        const transport = router.getTransport(transportId);
        
        // Find producer from any source
        let producer = Array.from(producers.values()).find(p => p.id === producerId);
        
        if (!producer) {
          // Try to find in WHIP producers
          for (const whipData of whipProducers.values()) {
            producer = whipData.producers.find(p => p.id === producerId);
            if (producer) break;
          }
        }

        if (!producer) {
          callback({ error: 'Producer not found' });
          return;
        }

        if (!router.canConsume({ producerId, rtpCapabilities })) {
          callback({ error: 'Cannot consume' });
          return;
        }

        const consumer = await transport.consume({
          producerId,
          rtpCapabilities
        });

        consumers.set(socket.id, consumer);

        consumer.on('transportclose', () => {
          consumers.delete(socket.id);
        });

        callback({
          params: {
            id: consumer.id,
            producerId: consumer.producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters
          }
        });
      });

      socket.on('resume', async (callback) => {
        const consumer = consumers.get(socket.id);
        if (consumer) {
          await consumer.resume();
        }
        callback({});
      });

    } catch (error) {
      console.error('[WebRTC] Error creating transport:', error);
      callback({ error: error.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('[WebRTC] Client disconnected:', socket.id);
    const producer = producers.get(socket.id);
    if (producer) {
      producer.close();
      producers.delete(socket.id);
    }
    const consumer = consumers.get(socket.id);
    if (consumer) {
      consumer.close();
      consumers.delete(socket.id);
    }
  });
});

// No RTMP needed - WHIP handles everything!

// Serve HTML page
app.get('/', (req, res) => {
  const host = req.get('host');
  const protocol = req.protocol;
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>WebRTC Audio Stream</title>
      <script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/mediasoup-client@3.6.47/lib/mediasoup-client.min.js"></script>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          padding: 20px;
          display: flex;
          justify-content: center;
          align-items: center;
        }
        .container {
          background: white;
          border-radius: 15px;
          padding: 30px;
          box-shadow: 0 10px 40px rgba(0,0,0,0.2);
          max-width: 600px;
          width: 100%;
        }
        h1 { color: #667eea; margin-bottom: 20px; text-align: center; }
        .status {
          padding: 15px;
          border-radius: 10px;
          margin-bottom: 20px;
          text-align: center;
          font-weight: 500;
        }
        .status.waiting { background: #fff3cd; color: #856404; }
        .status.connected { background: #d4edda; color: #155724; }
        .status.error { background: #f8d7da; color: #721c24; }
        button {
          background: #667eea;
          color: white;
          border: none;
          padding: 12px 30px;
          border-radius: 8px;
          font-size: 16px;
          cursor: pointer;
          width: 100%;
          margin-top: 10px;
        }
        button:hover { background: #5568d3; }
        button:disabled { background: #ccc; cursor: not-allowed; }
        .info {
          background: #e7f3ff;
          border-left: 4px solid #2196F3;
          padding: 12px;
          margin-top: 15px;
          border-radius: 4px;
          font-size: 13px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🎵 WebRTC Audio Stream</h1>
        <div id="status" class="status waiting">⏳ Ready to connect</div>
        <button id="connectBtn">▶️ Connect to Stream</button>
        <audio id="audioPlayer" controls style="width: 100%; margin-top: 20px;"></audio>
        <div class="info">
          💡 <strong>Note:</strong> WebRTC provides low-latency streaming (sub-second latency).
          OBS should stream via WHIP to: <code>${protocol}://${host}/whip/stream</code>
        </div>
      </div>
      <script>
        const socket = io('${protocol}://${host}');
        const status = document.getElementById('status');
        const connectBtn = document.getElementById('connectBtn');
        const audioPlayer = document.getElementById('audioPlayer');
        
        let device;
        let recvTransport;
        let consumer;
        
        connectBtn.addEventListener('click', async () => {
          try {
            status.className = 'status waiting';
            status.textContent = '⏳ Connecting...';
            connectBtn.disabled = true;
            
            // Get router capabilities
            const { rtpCapabilities } = await new Promise((resolve, reject) => {
              socket.emit('getRouterRtpCapabilities', (data) => {
                if (data.error) reject(new Error(data.error));
                else resolve(data);
              });
            });
            
            // Initialize mediasoup device
            device = new mediasoupClient.Device();
            await device.load({ routerRtpCapabilities: rtpCapabilities });
            
            // Create receive transport
            const { params: transportParams } = await new Promise((resolve, reject) => {
              socket.emit('createTransport', { type: 'recv' }, (data) => {
                if (data.error) reject(new Error(data.error));
                else resolve(data);
              });
            });
            
            recvTransport = device.createRecvTransport(transportParams);
            
            recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
              socket.emit('connect-transport', {
                transportId: recvTransport.id,
                dtlsParameters
              }, (data) => {
                if (data.error) errback(new Error(data.error));
                else callback();
              });
            });
            
            // Get available producers
            const { producers } = await new Promise((resolve, reject) => {
              socket.emit('getProducers', (data) => {
                if (data.error) reject(new Error(data.error));
                else resolve(data);
              });
            });
            
            if (producers.length === 0) {
              throw new Error('No active streams available. Make sure OBS is streaming via WHIP.');
            }
            
            // Use the first available producer (or you could let user choose)
            const producer = producers[0];
            console.log('Using producer:', producer);
            
            // Consume the stream
            const { params: consumeParams } = await new Promise((resolve, reject) => {
              socket.emit('consume', {
                transportId: recvTransport.id,
                producerId: producer.id,
                rtpCapabilities: device.rtpCapabilities
              }, (data) => {
                if (data.error) reject(new Error(data.error));
                else resolve(data);
              });
            });
            
            consumer = await recvTransport.consume(consumeParams);
            
            // Resume consumer
            socket.emit('resume', () => {});
            
            // Create audio stream from consumer track
            const stream = new MediaStream([consumer.track]);
            audioPlayer.srcObject = stream;
            
            await audioPlayer.play();
            
            status.className = 'status connected';
            status.textContent = '✅ Connected and playing!';
            connectBtn.textContent = '✓ Connected';
            
          } catch (error) {
            console.error('Error:', error);
            status.className = 'status error';
            status.textContent = '❌ Connection failed: ' + error.message;
            connectBtn.disabled = false;
            connectBtn.textContent = '🔄 Retry';
          }
        });
      </script>
    </body>
    </html>
  `);
});

// Start servers
async function start() {
  try {
    await createMediasoupWorker();
    
    console.log('═══════════════════════════════════════════');
    console.log('   🚀 WebRTC Audio Stream Server (WHIP)');
    console.log(`   📡 WHIP Endpoint: /whip/:resourceId`);
    console.log(`   🌐 HTTP Port: ${HTTP_PORT}`);
    console.log('═══════════════════════════════════════════');
    
    server.listen(HTTP_PORT, '0.0.0.0', () => {
      console.log(`   ✅ Server running on port ${HTTP_PORT}`);
      console.log('═══════════════════════════════════════════');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

