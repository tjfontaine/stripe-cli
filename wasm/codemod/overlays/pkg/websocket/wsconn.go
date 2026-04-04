package websocket

import "time"

// wsConnIface abstracts the websocket connection methods used by Client.
// On native platforms, *ws.Conn satisfies this. On wasip1, *wsConn (backed
// by wasmbridge) satisfies it.
type wsConnIface interface {
	ReadMessage() (messageType int, p []byte, err error)
	WriteMessage(messageType int, data []byte) error
	WriteJSON(v interface{}) error
	WriteControl(messageType int, data []byte, deadline time.Time) error
	SetPongHandler(h func(appData string) error)
	SetReadDeadline(t time.Time) error
	SetWriteDeadline(t time.Time) error
	Close() error
}
