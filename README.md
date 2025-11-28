# WebRTC Audio Stream Server

A low-latency audio streaming server using WebRTC for real-time audio delivery.

## Features

- **Low Latency**: WebRTC provides sub-second latency (vs 2+ seconds for HLS)
- **RTMP Input**: Accepts RTMP streams from OBS or other streaming software
- **WebRTC Output**: Serves streams via WebRTC to browsers
- **Mobile Compatible**: Works on mobile browsers with WebRTC support

## Setup

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

## OBS Configuration (WHIP)

1. In OBS, go to **Settings → Stream**
2. **Service**: Custom
3. **Server**: `https://your-server.com/whip/stream` (or `http://` if not using HTTPS)
4. **Stream Key**: Leave empty (WHIP doesn't use stream keys)

**Note**: OBS 30+ supports WHIP natively. For older versions, you may need a WHIP plugin.

## Usage

1. Start streaming from OBS
2. Open the web interface at `http://your-server:3000`
3. Click "Connect to Stream" to start receiving audio

## Architecture

- **Node Media Server**: Receives RTMP streams
- **Mediasoup**: WebRTC media server for low-latency streaming
- **Socket.IO**: Signaling for WebRTC connections
- **Express**: HTTP server and web interface

## Note

This is a basic implementation. For production use, you'll need:
- RTMP to WebRTC conversion (using FFmpeg or GStreamer)
- Proper producer management
- Authentication/authorization
- Better error handling

## Deployment

The server can be deployed to Railway, Heroku, or any Node.js hosting platform.

