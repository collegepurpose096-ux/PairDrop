import {WebSocketServer} from "ws";
import crypto from "crypto"

import Peer from "./peer.js";
import {hasher, randomizer} from "./helper.js";

export default class PairDropWsServer {

    constructor(server, conf) {
        this._conf = conf

        this._rooms = {}; // { roomId: peers[] }

        this._roomSecrets = {}; // { pairKey: roomSecret }
        this._keepAliveTimers = {};

        // WebSocket settings
        this._wss = new WebSocketServer({ 
            server,
            perMessageDeflate: false,
            maxPayload: 100 * 1024 * 1024,
            backlog: 1024,
        });
        
        console.log("✓ WebSocket Server initialized on port", conf.port);
        
        this._wss.on('connection', (socket, request) => {
            console.log("\n🔌 New connection attempt from:", request.socket.remoteAddress);
            
            socket.binaryType = 'nodebuffer';
            if (socket._socket) {
                socket._socket.setNoDelay(true);
                socket._socket.setKeepAlive(true, 1000);
            }
            
            this._onConnection(new Peer(socket, request, conf));
        });

        this._wss.on('error', (error) => {
            console.error("❌ WebSocket Server Error:", error);
        });

        // Log active connections every 10 seconds
        setInterval(() => {
            const totalPeers = Object.values(this._rooms).reduce((sum, room) => sum + Object.keys(room).length, 0);
            const roomCount = Object.keys(this._rooms).length;
            console.log(`📊 Status: ${totalPeers} peers in ${roomCount} rooms`);
            
            if (this._conf.debugMode) {
                console.log("Active rooms:", Object.keys(this._rooms));
                for (const roomId in this._rooms) {
                    console.log(`  Room ${roomId}:`, Object.keys(this._rooms[roomId]).length, "peers");
                }
            }
        }, 10000);
    }

    _onConnection(peer) {
        console.log("✓ Peer connected:", {
            id: peer.id,
            ip: peer.ip,
            name: peer.name.deviceName,
            displayName: peer.name.displayName
        });

        peer.socket.on('message', message => this._onMessage(peer, message));
        peer.socket.on('close', () => {
            console.log("🔌 Peer disconnected:", peer.id);
            this._onDisconnect(peer);
        });
        peer.socket.onerror = e => {
            console.error("❌ Socket error for peer", peer.id, ":", e);
        };

        this._keepAlive(peer);

        this._send(peer, {
            type: 'ws-config',
            wsConfig: {
                rtcConfig: {
                    ...this._conf.rtcConfig,
                    iceTransportPolicy: 'all',
                    bundlePolicy: 'max-bundle',
                    rtcpMuxPolicy: 'require',
                    iceCandidatePoolSize: 10,
                },
                wsFallback: this._conf.wsFallback,
                chunkSize: 10 * 1024 * 1024,
                maxParallelTransfers: 8,
                disableThrottling: true
            }
        });

        // send displayName
        this._send(peer, {
            type: 'display-name',
            displayName: peer.name.displayName,
            deviceName: peer.name.deviceName,
            peerId: peer.id,
            peerIdHash: hasher.hashCodeSalted(peer.id)
        });

        console.log("✓ Sent initial config to peer:", peer.id);
    }

    _onMessage(sender, message) {
        // Handle binary messages directly
        if (message instanceof Buffer) {
            this._relayBinaryMessage(sender, message);
            return;
        }

        // Try to parse message
        try {
            message = JSON.parse(message);
        } catch (e) {
            console.warn("⚠️  WS: Received JSON is malformed from peer", sender.id);
            return;
        }

        // Log important messages
        if (['join-ip-room', 'join-public-room', 'create-public-room', 'pair-device-initiate'].includes(message.type)) {
            console.log(`📨 Received ${message.type} from peer ${sender.id}`);
        }

        switch (message.type) {
            case 'disconnect':
                this._onDisconnect(sender);
                break;
            case 'pong':
                this._setKeepAliveTimerToNow(sender);
                break;
            case 'join-ip-room':
                console.log(`🏠 Peer ${sender.id} joining IP room: ${sender.ip}`);
                this._joinIpRoom(sender);
                break;
            case 'room-secrets':
                this._onRoomSecrets(sender, message);
                break;
            case 'room-secrets-deleted':
                this._onRoomSecretsDeleted(sender, message);
                break;
            case 'pair-device-initiate':
                this._onPairDeviceInitiate(sender);
                break;
            case 'pair-device-join':
                this._onPairDeviceJoin(sender, message);
                break;
            case 'pair-device-cancel':
                this._onPairDeviceCancel(sender);
                break;
            case 'regenerate-room-secret':
                this._onRegenerateRoomSecret(sender, message);
                break;
            case 'create-public-room':
                this._onCreatePublicRoom(sender);
                break;
            case 'join-public-room':
                this._onJoinPublicRoom(sender, message);
                break;
            case 'leave-public-room':
                this._onLeavePublicRoom(sender);
                break;
            case 'signal':
                this._signalAndRelay(sender, message);
                break;
            case 'request':
            case 'header':
            case 'partition':
            case 'partition-received':
            case 'progress':
            case 'files-transfer-response':
            case 'file-transfer-complete':
            case 'message-transfer-complete':
            case 'text':
            case 'display-name-changed':
            case 'ws-chunk':
            case 'ws-chunk-binary':
                if (this._conf.wsFallback) {
                    this._signalAndRelay(sender, message);
                }
                else {
                    console.log("⚠️  Websocket fallback is not activated on this instance.")
                }
                break;
            default:
                if (this._conf.debugMode) {
                    console.log(`📨 Unhandled message type: ${message.type}`);
                }
        }
    }

    _relayBinaryMessage(sender, binaryData) {
        if (!this._conf.wsFallback) return;
        
        const recipientId = binaryData.slice(0, 36).toString('utf8');
        const roomType = binaryData.slice(36, 37).toString('utf8');
        
        const room = roomType === 'i' ? sender.ip : binaryData.slice(37, 101).toString('utf8').trim();
        
        if (Peer.isValidUuid(recipientId) && this._rooms[room]) {
            const recipient = this._rooms[room][recipientId];
            if (recipient && recipient.socket.readyState === 1) {
                recipient.socket.send(binaryData.slice(101), { binary: true });
            }
        }
    }

    _signalAndRelay(sender, message) {
        const room = message.roomType === 'ip'
            ? sender.ip
            : message.roomId;

        if (message.to && Peer.isValidUuid(message.to) && this._rooms[room]) {
            const recipient = this._rooms[room][message.to];
            if (!recipient) {
                console.warn(`⚠️  Recipient ${message.to} not found in room ${room}`);
                return;
            }
            
            delete message.to;
            message.sender = {
                id: sender.id,
                rtcSupported: sender.rtcSupported
            };
            this._send(recipient, message);
        } else if (!this._rooms[room]) {
            console.warn(`⚠️  Room ${room} does not exist for signal relay`);
        }
    }

    _onDisconnect(sender) {
        this._disconnect(sender);
    }

    _disconnect(sender) {
        this._removePairKey(sender.pairKey);
        sender.pairKey = null;

        this._cancelKeepAlive(sender);
        delete this._keepAliveTimers[sender.id];

        this._leaveIpRoom(sender, true);
        this._leaveAllSecretRooms(sender, true);
        this._leavePublicRoom(sender, true);

        if (sender.socket.readyState === 1) {
            sender.socket.terminate();
        }
    }

    _onRoomSecrets(sender, message) {
        if (!message.roomSecrets) return;

        const roomSecrets = message.roomSecrets.filter(roomSecret => {
            return /^[\x00-\x7F]{64,256}$/.test(roomSecret);
        })

        if (!roomSecrets || roomSecrets.length === 0) return;

        console.log(`🔐 Peer ${sender.id} joining ${roomSecrets.length} secret room(s)`);
        this._joinSecretRooms(sender, roomSecrets);
    }

    _onRoomSecretsDeleted(sender, message) {
        for (let i = 0; i<message.roomSecrets.length; i++) {
            this._deleteSecretRoom(message.roomSecrets[i]);
        }
    }

    _deleteSecretRoom(roomSecret) {
        const room = this._rooms[roomSecret];
        if (!room) return;

        console.log(`🗑️  Deleting secret room with ${Object.keys(room).length} peers`);

        for (const peerId in room) {
            const peer = room[peerId];

            this._leaveSecretRoom(peer, roomSecret, true);

            this._send(peer, {
                type: 'secret-room-deleted',
                roomSecret: roomSecret,
            });
        }
    }

    _onPairDeviceInitiate(sender) {
        let roomSecret = randomizer.getRandomString(256);
        let pairKey = this._createPairKey(sender, roomSecret);

        if (sender.pairKey) {
            this._removePairKey(sender.pairKey);
        }
        sender.pairKey = pairKey;

        console.log(`🔗 Pair key created: ${pairKey} for peer ${sender.id}`);

        this._send(sender, {
            type: 'pair-device-initiated',
            roomSecret: roomSecret,
            pairKey: pairKey
        });
        this._joinSecretRoom(sender, roomSecret);
    }

    _onPairDeviceJoin(sender, message) {
        if (sender.rateLimitReached()) {
            this._send(sender, { type: 'join-key-rate-limit' });
            return;
        }

        if (!this._roomSecrets[message.pairKey] || sender.id === this._roomSecrets[message.pairKey].creator.id) {
            console.log(`❌ Invalid pair key: ${message.pairKey}`);
            this._send(sender, { type: 'pair-device-join-key-invalid' });
            return;
        }

        const roomSecret = this._roomSecrets[message.pairKey].roomSecret;
        const creator = this._roomSecrets[message.pairKey].creator;
        this._removePairKey(message.pairKey);
        
        console.log(`✓ Pair successful: ${sender.id} joined ${creator.id}`);
        
        this._send(sender, {
            type: 'pair-device-joined',
            roomSecret: roomSecret,
            peerId: creator.id
        });
        this._send(creator, {
            type: 'pair-device-joined',
            roomSecret: roomSecret,
            peerId: sender.id
        });
        this._joinSecretRoom(sender, roomSecret);
        this._removePairKey(sender.pairKey);
    }

    _onPairDeviceCancel(sender) {
        const pairKey = sender.pairKey

        if (!pairKey) return;

        this._removePairKey(pairKey);
        this._send(sender, {
            type: 'pair-device-canceled',
            pairKey: pairKey,
        });
    }

    _onCreatePublicRoom(sender) {
        let publicRoomId = randomizer.getRandomString(5, true).toLowerCase();

        console.log(`🌐 Public room created: ${publicRoomId} by peer ${sender.id}`);

        this._send(sender, {
            type: 'public-room-created',
            roomId: publicRoomId
        });

        this._joinPublicRoom(sender, publicRoomId);
    }

    _onJoinPublicRoom(sender, message) {
        if (sender.rateLimitReached()) {
            this._send(sender, { type: 'join-key-rate-limit' });
            return;
        }

        if (!this._rooms[message.publicRoomId] && !message.createIfInvalid) {
            console.log(`❌ Invalid public room ID: ${message.publicRoomId}`);
            this._send(sender, { type: 'public-room-id-invalid', publicRoomId: message.publicRoomId });
            return;
        }

        this._leavePublicRoom(sender);
        this._joinPublicRoom(sender, message.publicRoomId);
    }

    _onLeavePublicRoom(sender) {
        this._leavePublicRoom(sender, true);
        this._send(sender, { type: 'public-room-left' });
    }

    _onRegenerateRoomSecret(sender, message) {
        const oldRoomSecret = message.roomSecret;
        const newRoomSecret = randomizer.getRandomString(256);

        for (const peerId in this._rooms[oldRoomSecret]) {
            const peer = this._rooms[oldRoomSecret][peerId];
            this._send(peer, {
                type: 'room-secret-regenerated',
                oldRoomSecret: oldRoomSecret,
                newRoomSecret: newRoomSecret,
            });
            peer.removeRoomSecret(oldRoomSecret);
        }
        delete this._rooms[oldRoomSecret];
    }

    _createPairKey(creator, roomSecret) {
        let pairKey;
        do {
            pairKey = crypto.randomInt(1000000, 1999999).toString().substring(1);
        } while (pairKey in this._roomSecrets)

        this._roomSecrets[pairKey] = {
            roomSecret: roomSecret,
            creator: creator
        }

        return pairKey;
    }

    _removePairKey(pairKey) {
        if (pairKey in this._roomSecrets) {
            this._roomSecrets[pairKey].creator.pairKey = null
            delete this._roomSecrets[pairKey];
        }
    }

    _joinIpRoom(peer) {
        this._joinRoom(peer, 'ip', peer.ip);
    }

    _joinSecretRoom(peer, roomSecret) {
        this._joinRoom(peer, 'secret', roomSecret);
        peer.addRoomSecret(roomSecret);
    }

    _joinPublicRoom(peer, publicRoomId) {
        this._leavePublicRoom(peer);
        this._joinRoom(peer, 'public-id', publicRoomId);
        peer.publicRoomId = publicRoomId;
    }

    _joinRoom(peer, roomType, roomId) {
        if (this._rooms[roomId] && this._rooms[roomId][peer.id]) {
            this._leaveRoom(peer, roomType, roomId);
        }

        if (!this._rooms[roomId]) {
            this._rooms[roomId] = {};
            console.log(`🏠 Created new room: ${roomId} (type: ${roomType})`);
        }

        this._notifyPeers(peer, roomType, roomId);

        this._rooms[roomId][peer.id] = peer;
        
        const peerCount = Object.keys(this._rooms[roomId]).length;
        console.log(`✓ Peer ${peer.id} joined room ${roomId} (${peerCount} peer${peerCount !== 1 ? 's' : ''} total)`);
    }

    _leaveIpRoom(peer, disconnect = false) {
        this._leaveRoom(peer, 'ip', peer.ip, disconnect);
    }

    _leaveSecretRoom(peer, roomSecret, disconnect = false) {
        this._leaveRoom(peer, 'secret', roomSecret, disconnect)
        peer.removeRoomSecret(roomSecret);
    }

    _leavePublicRoom(peer, disconnect = false) {
        if (!peer.publicRoomId) return;
        this._leaveRoom(peer, 'public-id', peer.publicRoomId, disconnect);
        peer.publicRoomId = null;
    }

    _leaveRoom(peer, roomType, roomId, disconnect = false) {
        if (!this._rooms[roomId] || !this._rooms[roomId][peer.id]) return;

        delete this._rooms[roomId][peer.id];

        if (!Object.keys(this._rooms[roomId]).length) {
            delete this._rooms[roomId];
            console.log(`🗑️  Deleted empty room: ${roomId}`);
            return;
        }

        for (const otherPeerId in this._rooms[roomId]) {
            const otherPeer = this._rooms[roomId][otherPeerId];

            let msg = {
                type: 'peer-left',
                peerId: peer.id,
                roomType: roomType,
                roomId: roomId,
                disconnect: disconnect
            };

            this._send(otherPeer, msg);
        }
    }

    _notifyPeers(peer, roomType, roomId) {
        if (!this._rooms[roomId]) return;

        // notify all other peers that peer joined
        for (const otherPeerId in this._rooms[roomId]) {
            if (otherPeerId === peer.id) continue;
            const otherPeer = this._rooms[roomId][otherPeerId];

            let msg = {
                type: 'peer-joined',
                peer: peer.getInfo(),
                roomType: roomType,
                roomId: roomId
            };

            this._send(otherPeer, msg);
            console.log(`📢 Notified peer ${otherPeerId} about new peer ${peer.id} in room ${roomId}`);
        }

        // notify peer about peers already in the room
        const otherPeers = [];
        for (const otherPeerId in this._rooms[roomId]) {
            if (otherPeerId === peer.id) continue;
            otherPeers.push(this._rooms[roomId][otherPeerId].getInfo());
        }

        let msg = {
            type: 'peers',
            peers: otherPeers,
            roomType: roomType,
            roomId: roomId
        };

        this._send(peer, msg);
        
        if (otherPeers.length > 0) {
            console.log(`📢 Sent ${otherPeers.length} existing peer(s) to new peer ${peer.id}`);
        }
    }

    _joinSecretRooms(peer, roomSecrets) {
        for (let i=0; i<roomSecrets.length; i++) {
            this._joinSecretRoom(peer, roomSecrets[i])
        }
    }

    _leaveAllSecretRooms(peer, disconnect = false) {
        for (let i=0; i<peer.roomSecrets.length; i++) {
            this._leaveSecretRoom(peer, peer.roomSecrets[i], disconnect);
        }
    }

    _send(peer, message) {
        if (!peer) return;
        if (peer.socket.readyState !== 1) {
            console.warn(`⚠️  Cannot send to peer ${peer.id}, socket state: ${peer.socket.readyState}`);
            return;
        }
        
        message = JSON.stringify(message);
        
        try {
            peer.socket.send(message, { compress: false });
        } catch (error) {
            console.error(`❌ Error sending to peer ${peer.id}:`, error.message);
        }
    }

    _keepAlive(peer) {
        this._cancelKeepAlive(peer);
        let timeout = 2000;

        if (!this._keepAliveTimers[peer.id]) {
            this._keepAliveTimers[peer.id] = {
                timer: 0,
                lastBeat: Date.now()
            };
        }

        if (Date.now() - this._keepAliveTimers[peer.id].lastBeat > 3 * timeout) {
            console.log(`💔 Peer ${peer.id} unresponsive, disconnecting`);
            this._disconnect(peer);
            return;
        }

        this._send(peer, { type: 'ping' });

        this._keepAliveTimers[peer.id].timer = setTimeout(() => this._keepAlive(peer), timeout);
    }

    _cancelKeepAlive(peer) {
        if (this._keepAliveTimers[peer.id]?.timer) {
            clearTimeout(this._keepAliveTimers[peer.id].timer);
        }
    }

    _setKeepAliveTimerToNow(peer) {
        if (this._keepAliveTimers[peer.id]?.lastBeat) {
            this._keepAliveTimers[peer.id].lastBeat = Date.now();
        }
    }
}
