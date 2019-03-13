import * as bodyParser from 'body-parser';
import * as cors from 'cors';
import * as express from 'express';
import * as asyncHandler from 'express-async-handler';
import * as http from 'http';
import * as _ from 'lodash';
import * as WebSocket from 'websocket';

import { assertConfigsAreValid } from './assertions';
import { constants } from './constants';
import { hasDBConnection, initDBConnectionAsync } from './db_connection';
import { GeneralErrorCodes, ValidationErrorCodes } from './errors';
import { Handlers } from './handlers';
import { errorHandler } from './middleware/error_handling';
import { urlParamsParsing } from './middleware/url_params_parsing';
import { BroadcastMessage, Configs, NetworkIdToConnectionStore, NetworkIdToProvider } from './types';
import { utils } from './utils';

const networkIdToConnectionStore: NetworkIdToConnectionStore = {};

/**
 * Creates a new express app/server
 * @param provider Ethereum JSON RPC client for interfacing with Ethereum and signing coordinator approvals
 */
export async function getAppAsync(networkIdToProvider: NetworkIdToProvider, configs: Configs): Promise<http.Server> {
    assertConfigsAreValid(configs);
    if (!hasDBConnection()) {
        await initDBConnectionAsync();
    }

    const handlers = new Handlers(networkIdToProvider, configs, broadcastCallback);
    const app = express();
    app.use(cors());
    app.use(bodyParser.json());
    const supportedNetworkIds = utils.getSupportedNetworkIds(configs);
    app.use(urlParamsParsing.bind(undefined, supportedNetworkIds));

    /**
     * POST endpoint for requesting signatures for a 0x transaction
     */
    app.post('/v1/request_transaction', asyncHandler(handlers.postRequestTransactionAsync.bind(handlers)));

    app.use(errorHandler);

    /**
     * Create WebSocket server for broadcasting coordinator notifications
     */
    const server = http.createServer(app);
    const wss = new WebSocket.server({
        httpServer: server,
        // Avoid setting autoAcceptConnections to true as it defeats all
        // standard cross-origin procoordinatortion facilities built into the protocol
        // and the browser.
        // Source: https://www.npmjs.com/package/websocket#server-example
        // Also ensures that a request event is emitted by
        // the server whenever a new WebSocket request is made.
        autoAcceptConnections: false,
    });

    /**
     * WebSocket endpoint for subscribing to transaction request notifications
     */
    wss.on('request', async (request: any) => {
        // If the request isn't to the expected endpoint, reject
        if (!_.includes(request.resourceURL.path, '/v1/requests')) {
            request.reject(404, 'NOT_FOUND');
            return;
        }
        const networkIdStr = request.resourceURL.query.networkId || constants.DEFAULT_NETWORK_ID.toString();
        const networkId = _.parseInt(networkIdStr);
        if (!_.includes(supportedNetworkIds, networkId)) {
            const body = {
                code: GeneralErrorCodes.ValidationError,
                reason: 'Validation Failed',
                validationErrors: [
                    {
                        field: 'networkId',
                        code: ValidationErrorCodes.UnsupportedOption,
                        reason: 'Requested networkId not supported by this coordinator',
                    },
                ],
            };
            request.reject(400, body);
            return;
        }

        // We do not do origin checks because we want to let anyone subscribe to this endpoint
        // COORDINATOR_OPERATOR: Implement additional credentialling here if desired
        const connection: WebSocket.connection = request.accept(null, request.origin);

        // Note: We don't handle the `message` event because this is a broadcast-only endpoint
        if (networkIdToConnectionStore[networkId] === undefined) {
            networkIdToConnectionStore[networkId] = new Set<WebSocket.connection>();
        }
        networkIdToConnectionStore[networkId].add(connection);
        connection.on('close', () => {
            networkIdToConnectionStore[networkId].delete(connection);
        });
    });

    return server;
}

function broadcastCallback(event: BroadcastMessage, networkId: number): void {
    const connectionStore = networkIdToConnectionStore[networkId] || new Set<WebSocket.connection>();
    connectionStore.forEach((connection: WebSocket.connection) => {
        connection.sendUTF(JSON.stringify(event));
    });
}
