//go:build wasip1

// conn_wasip1.go replaces the gorilla websocket connection with a wasmbridge
// connection for WASM builds. The browser's native WebSocket API handles the
// HTTP upgrade, TLS, ping/pong, and keepalive internally.

package websocket

import (
	"encoding/json"
	"time"

	"github.com/stripe/stripe-cli/pkg/wasmbridge"
)

// wsConn wraps wasmbridge.Conn with the methods that Client uses on *ws.Conn.
type wsConn struct {
	inner *wasmbridge.Conn
}

func (c *wsConn) ReadMessage() (int, []byte, error) {
	msgType, data, err := c.inner.ReadMessage()
	return int(msgType), data, err
}

func (c *wsConn) WriteMessage(messageType int, data []byte) error {
	return c.inner.WriteMessage(wasmbridge.MessageType(messageType), data)
}

func (c *wsConn) WriteJSON(v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.inner.WriteMessage(wasmbridge.TextMessage, data)
}

func (c *wsConn) WriteControl(messageType int, data []byte, _ time.Time) error {
	return c.inner.WriteMessage(wasmbridge.MessageType(messageType), data)
}

func (c *wsConn) SetPongHandler(_ func(string) error) {
	// Browser WebSocket handles ping/pong internally
}

func (c *wsConn) SetReadDeadline(_ time.Time) error {
	return nil // Browser manages timeouts
}

func (c *wsConn) SetWriteDeadline(_ time.Time) error {
	return nil
}

func (c *wsConn) Close() error {
	return c.inner.Close()
}

// dialWasm connects via the wasmbridge host import, returning a wsConn
// that can be used by the Client's read/write pumps.
func dialWasm(url string) (*wsConn, error) {
	conn, err := wasmbridge.Dial(url)
	if err != nil {
		return nil, err
	}
	return &wsConn{inner: conn}, nil
}
