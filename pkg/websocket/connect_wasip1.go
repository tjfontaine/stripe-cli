//go:build wasip1

package websocket

import (
	"context"
	"strings"
	"sync"

	log "github.com/sirupsen/logrus"
)

// connect dials the websocket using the wasmbridge host import (browser WebSocket).
// This replaces the gorilla-based connect for native platforms.
func (c *Client) connect(ctx context.Context) error {
	url := c.URL
	if c.cfg.NoWSS && strings.HasPrefix(url, "wss") {
		url = "ws" + strings.TrimPrefix(c.URL, "wss")
	}

	url = url + "?websocket_feature=" + c.WebSocketAuthorizedFeature

	c.cfg.Log.WithFields(log.Fields{
		"prefix": "websocket.Client.connect",
		"url":    url,
	}).Debug("Dialing websocket (wasmbridge)")

	conn, err := dialWasm(url)
	if err != nil {
		c.cfg.Log.WithFields(log.Fields{
			"prefix": "websocket.Client.connect",
			"error":  err,
		}).Debug("Websocket connection error")
		return err
	}

	c.changeConnection(conn)
	c.setIsConnected(true)

	c.wg = &sync.WaitGroup{}
	c.wg.Add(2)

	go c.readPump()
	go c.writePump()

	c.cfg.Log.WithFields(log.Fields{
		"prefix": "websocket.Client.connect",
	}).Debug("Connected!")

	return nil
}
