import http from 'http';
import https from 'https';
import { Http3Server } from "@fails-components/webtransport";
import { URL } from 'url';

import { matchMaker, Protocol, Transport, debugAndPrintError, spliceOne } from '@colyseus/core';
import { H3Client } from './H3Client';
import { generateWebTransportCertificate } from './utils/mkcert';

export type CertLike = string | Buffer;

export interface TransportOptions {
  app: any, // express app

  cert?: CertLike,
  key?: CertLike,

  secret?: string,

  server?: http.Server,

  localProxy?: string,
}

export class H3Transport extends Transport {
  public protocol: string = "h3";
  public clients: H3Client[] = [];

  protected http: http.Server;
  protected https: https.Server;
  protected h3Server: Http3Server;

  private options: TransportOptions;
  private isListening = false;

  private _originalSend: any = null;

  constructor(options: TransportOptions) {
    super();

    this.options = options;

    // local proxy (frontend)
    if (options.localProxy) {
      if (this.options.server) {
        console.warn("H3Transport: 'server' option is ignored when 'localProxy' is set.");
      }

      const uri = new URL(
        (!options.localProxy.startsWith("http"))
          ? `http://${options.localProxy}`
          : options.localProxy
      );

      this.options.server = http.createServer((req, res) => {
        const proxyReq = http.request({
          host: uri.hostname,
          port: uri.port,
          path: req.url,
          method: req.method,
          headers: req.headers,
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode!, proxyRes.headers);
          proxyRes.pipe(res, { end: true });
        });
        req.pipe(proxyReq, { end: true });
        proxyReq.on('error', (err) => {
          console.error('Proxy request error:', err);
          res.end();
        });
      });

    }
  }

  public listen(port: number, hostname: string = 'localhost', backlog?: number, listeningListener?: () => void) {
    const createServers = (cert: CertLike, key: CertLike, fingerprint?: string) => {
      this.http = this.options.server || http.createServer(this.options.app);
      this.http.listen(port);

      if (fingerprint) {
        // return fingerprint on __fingerprint request (development only)
        this.options.app.get("/__fingerprint", (req: any, res: any) => {
          res.json(fingerprint!.split(":").map((hex) => parseInt(hex, 16)));
        });
      }

      if (this.options.localProxy) {
        // use http proxy server
        this.options.app.use((req: any, res: any) => {
          this.options.server.emit('request', req, res);
        });
      }

      this.https = https.createServer({ cert, key }, this.options.app);
      this.https.listen(port, hostname, backlog, listeningListener);

      this.h3Server = new Http3Server({
        host: hostname,
        port,
        secret: this.options.secret || "mysecret",
        cert: this.options.cert as string,
        privKey: this.options.key as string,
      });
      this.h3Server.startServer();

      this.isListening = true;
      this.loop();
    };

    if (!this.options.cert || !this.options.key) {
      //
      // TODO: cache certificate on filesystem for 10 days
      //
      generateWebTransportCertificate([
        { shortName: 'C', value: 'BR' },
        { shortName: 'ST', value: 'Rio Grande do Sul' },
        { shortName: 'L', value: 'Sapiranga' },
        { shortName: 'O', value: 'Colyseus WebTransport' },
        { shortName: 'CN', value: hostname },
      ], {
        days: 10,
      }).then((generated) => {
        createServers(generated.cert, generated.private, generated.fingerprint);
      });

    } else {
      createServers(this.options.cert, this.options.key);
    }

    return this;
  }

  public shutdown() {
    this.isListening = false;
    this.http.close();
    this.https.close();
    this.h3Server.stopServer();
  }

  public simulateLatency(milliseconds: number) {
    // if (this._originalSend == null) {
    //   this._originalSend = WebSocket.prototype.send;
    // }

    // const originalSend = this._originalSend;

    // WebSocket.prototype.send = milliseconds <= Number.EPSILON ? originalSend : function (...args: any[]) {
    //   setTimeout(() => originalSend.apply(this, args), milliseconds);
    // };
  }

  protected async onConnection(rawClient: any, req?: http.IncomingMessage & any) {
    // prevent server crashes if a single client had unexpected error
    rawClient.on('error', (err) => debugAndPrintError(err.message + '\n' + err.stack));

    // compatibility with ws / uws
    const upgradeReq = req || (rawClient as any).upgradeReq;
    const parsedURL = new URL(`ws://server/${upgradeReq.url}`);

    const sessionId = parsedURL.searchParams.get("sessionId");
    const processAndRoomId = parsedURL.pathname.match(/\/[a-zA-Z0-9_\-]+\/([a-zA-Z0-9_\-]+)$/);
    const roomId = processAndRoomId && processAndRoomId[1];

    const room = matchMaker.getRoomById(roomId);

    // set client id
    rawClient.pingCount = 0;

    // @ts-ignore
    const client = new H3Client(sessionId, rawClient);

    //
    // TODO: DRY code below with all transports
    //

    try {
      if (!room || !room.hasReservedSeat(sessionId, parsedURL.searchParams.get("reconnectionToken"))) {
        throw new Error('seat reservation expired.');
      }

      await room._onJoin(client, upgradeReq);

    } catch (e) {
      debugAndPrintError(e);

      // send error code to client then terminate
      client.error(e.code, e.message, () =>
        rawClient.close(Protocol.WS_CLOSE_WITH_ERROR));
    }
  }

  protected async loop() {
    try {
      const sessionStream = await this.h3Server.sessionStream("/");
      const sessionReader = sessionStream.getReader();
      sessionReader.closed.catch((e: any) => console.log("session reader closed with error!", e));

      while (this.isListening) {
        console.log("sessionReader.read() - waiting for session...");
        const { done, value } = await sessionReader.read();
        if (done) { break; }

        // create client instance
        const client = new H3Client(value);
        client.ref.on('open', () => this.clients.push(client));
        client.ref.on("close", () => spliceOne(this.clients, this.clients.indexOf(client)));
      }

    } catch (e) {
      console.error("error:", e);
    }
  }

}
