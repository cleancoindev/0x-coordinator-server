import * as _ from 'lodash';
import { Connection, createConnection } from 'typeorm';

let connectionIfExists: Connection | undefined;

/**
 * Checks if a connection already exists
 * @return Whether a connection exists
 */
export function hasDBConnection(): boolean {
    return !_.isUndefined(connectionIfExists);
}

/**
 * Returns the DB connnection
 */
export function getDBConnection(): Connection {
    if (_.isUndefined(connectionIfExists)) {
        throw new Error('DB connection not initialized');
    }
    return connectionIfExists;
}

/**
 * Creates the DB connnection to use in an app
 */
export async function initDBConnectionAsync(): Promise<void> {
    if (!_.isUndefined(connectionIfExists)) {
        throw new Error('DB connection already exists');
    }
    connectionIfExists = await createConnection();
}
