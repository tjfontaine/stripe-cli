//go:build wasip1

// proxy_wasip1.go replaces the goroutine-based proxy Run with a
// single-goroutine event loop for WASM. WebSocket read blocks via
// JSPI — no goroutines, no channels, no deadlocks.

package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"

	log "github.com/sirupsen/logrus"

	"github.com/stripe/stripe-cli/pkg/useragent"
	"github.com/stripe/stripe-cli/pkg/wasmbridge"
	"github.com/stripe/stripe-cli/pkg/websocket"
)

// Run connects to Stripe's WebSocket and processes events synchronously.
// This replaces the goroutine-based Run for wasip1 builds.
func (p *Proxy) Run(ctx context.Context) error {
	defer close(p.cfg.OutCh)

	p.cfg.OutCh <- websocket.StateElement{
		State: websocket.Loading,
	}

	session, err := p.createSession(ctx)
	if err != nil {
		p.cfg.OutCh <- websocket.ErrorElement{
			Error: fmt.Errorf("Error while authenticating with Stripe: %v", err),
		}
		return err
	}

	*p.cfg.DeviceToken = session.DeviceToken

	// Connect WebSocket via wasmbridge (JSPI suspends until open).
	// Encode auth headers as query params — the JS WebSocket proxy extracts
	// them and sends as HTTP headers on the upstream connection (browser
	// WebSocket API doesn't support custom headers).
	wsURL := session.WebSocketURL + "?websocket_feature=" + session.WebSocketAuthorizedFeature
	wsURL += "&_ws_header_Websocket-Id=" + url.QueryEscape(session.WebSocketID)
	wsURL += "&_ws_header_User-Agent=" + url.QueryEscape(useragent.GetEncodedUserAgent())
	wsURL += "&_ws_header_X-Stripe-Client-User-Agent=" + url.QueryEscape(useragent.GetEncodedStripeUserAgent())
	conn, err := wasmbridge.Dial(wsURL)
	if err != nil {
		p.cfg.OutCh <- websocket.ErrorElement{
			Error: fmt.Errorf("WebSocket connection failed: %v", err),
		}
		return err
	}
	defer conn.Close()

	// Store connection for sendMessage (package-level, safe in single-threaded wasip1)
	activeWsConn = conn

	displayedAPIVersion := ""
	if p.cfg.UseLatestAPIVersion && session.LatestVersion != "" {
		displayedAPIVersion = "You are using Stripe API Version [" + session.LatestVersion + "]. "
	} else if !p.cfg.UseLatestAPIVersion && session.DefaultVersion != "" {
		displayedAPIVersion = "You are using Stripe API Version [" + session.DefaultVersion + "]. "
	}

	p.cfg.OutCh <- websocket.StateElement{
		State: websocket.Ready,
		Data:  []string{displayedAPIVersion, session.Secret},
	}

	// Single-goroutine event loop — ReadMessage blocks via JSPI
	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			log.WithFields(log.Fields{
				"prefix": "proxy.Run.wasip1",
				"error":  err,
			}).Debug("WebSocket read error")
			break
		}

		if wasmbridge.MessageType(msgType) == wasmbridge.CloseMessage {
			break
		}

		// Parse and process the event synchronously
		var msg websocket.IncomingMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			log.WithFields(log.Fields{
				"prefix": "proxy.Run.wasip1",
				"data":   string(data),
			}).Debug("Received malformed message: ", err)
			continue
		}

		// Process synchronously (no goroutine)
		p.webhookEventProcessor.ProcessEvent(msg)
	}

	p.cfg.OutCh <- &websocket.StateElement{
		State: websocket.Done,
	}
	return nil
}
