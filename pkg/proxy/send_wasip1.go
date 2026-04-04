//go:build wasip1

package proxy

import (
	"encoding/json"

	log "github.com/sirupsen/logrus"

	"github.com/stripe/stripe-cli/pkg/wasmbridge"
	"github.com/stripe/stripe-cli/pkg/websocket"
)

// activeWsConn holds the wasmbridge WebSocket connection for direct writes.
// Set by Run (proxy_wasip1.go) before the event loop starts.
// Safe without mutex since wasip1 is single-threaded.
var activeWsConn *wasmbridge.Conn

// sendMessage writes an outgoing message directly to the WebSocket.
// This replaces the channel-based sendMessage that relies on writePump.
func (p *Proxy) sendMessage(msg *websocket.OutgoingMessage) {
	if activeWsConn == nil {
		return
	}

	data, err := json.Marshal(msg)
	if err != nil {
		log.WithFields(log.Fields{
			"prefix": "proxy.sendMessage.wasip1",
			"error":  err,
		}).Debug("Failed to marshal outgoing message")
		return
	}

	if err := activeWsConn.WriteMessage(wasmbridge.TextMessage, data); err != nil {
		log.WithFields(log.Fields{
			"prefix": "proxy.sendMessage.wasip1",
			"error":  err,
		}).Debug("Failed to write outgoing message")
	}
}
