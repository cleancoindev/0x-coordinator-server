import { OrderWithoutExchangeAddress } from '@0x/types';
import { BigNumber } from '@0x/utils';
import * as _ from 'lodash';

import { getDBConnection } from '../db_connection';
import { OrderEntity } from '../entities/order_entity';
import { TakerAssetFillAmountEntity } from '../entities/taker_asset_fill_amount_entity';
import { TransactionEntity } from '../entities/transaction_entity';
import { takerAssetFillAmountModel } from '../models/taker_asset_fill_amount_model';
import { OrderHashToFillAmount, OutstandingSignature } from '../types';

import { orderModel } from './order_model';

export const transactionModel = {
    async findAsync(takerAddress: string, signature: string): Promise<TransactionEntity | undefined> {
        const connection = getDBConnection();
        const transactionIfExists = await connection.manager.findOne(TransactionEntity, {
            takerAddress,
            signature,
        });
        return transactionIfExists;
    },
    async findByOrdersAsync(
        orders: OrderWithoutExchangeAddress[],
        opts?: {
            takerAddress?: string;
            isUnexpired?: boolean;
        },
    ): Promise<TransactionEntity[]> {
        const connection = getDBConnection();
        const orderHashes = _.map(orders, order => orderModel.getHash(order));
        let query = connection
            .getRepository(TransactionEntity)
            .createQueryBuilder('transaction')
            .leftJoinAndSelect('transaction.orders', 'order')
            .leftJoinAndSelect('transaction.takerAssetFillAmounts', 'takerAssetFillAmount')
            .where('order.hash IN (:...orderHashes)', { orderHashes });
        if (opts !== undefined && opts.takerAddress !== undefined) {
            query = query.andWhere('transaction.takerAddress = :takerAddress', { takerAddress: opts.takerAddress });
        }
        if (opts !== undefined && opts.isUnexpired) {
            const currentExpiration = Math.round(Date.now() / 1000);
            query = query.andWhere('transaction.expirationTimeSeconds > :currentExpiration', {
                currentExpiration,
            });
        }

        const transactionsIfExists = await query.getMany();
        if (transactionsIfExists === undefined) {
            return [];
        }
        return transactionsIfExists;
    },
    async createAsync(
        signature: string,
        expirationTimeSeconds: number,
        takerAddress: string,
        orders: OrderWithoutExchangeAddress[],
        takerAssetFillAmounts: BigNumber[],
    ): Promise<TransactionEntity> {
        let transactionEntity = new TransactionEntity();
        transactionEntity.signature = signature;
        transactionEntity.expirationTimeSeconds = expirationTimeSeconds;
        transactionEntity.takerAddress = takerAddress;

        const orderEntities: OrderEntity[] = [];
        const takerAssetFillAmountEntities: TakerAssetFillAmountEntity[] = [];
        for (let i = 0; i < orders.length; i++) {
            const order = orders[i];
            let orderEntityIfExists = await orderModel.findAsync(order);
            if (orderEntityIfExists === undefined) {
                orderEntityIfExists = await orderModel.createAsync(order);
            }
            orderEntities.push(orderEntityIfExists);
            const fillAmount = takerAssetFillAmounts[i];
            const takerAssetFillAmountEntity = await takerAssetFillAmountModel.createAsync(
                orderEntityIfExists,
                fillAmount,
            );
            takerAssetFillAmountEntities.push(takerAssetFillAmountEntity);
        }

        transactionEntity.orders = orderEntities;
        transactionEntity.takerAssetFillAmounts = takerAssetFillAmountEntities;
        const connection = getDBConnection();
        transactionEntity = await connection.manager.save(TransactionEntity, transactionEntity);
        return transactionEntity;
    },
    async getOrderHashToFillAmountRequestedAsync(
        orders: OrderWithoutExchangeAddress[],
        takerAddress: string,
    ): Promise<OrderHashToFillAmount> {
        const orderHashes = _.map(orders, o => orderModel.getHash(o));
        const transactions = await transactionModel.findByOrdersAsync(orders, { takerAddress });
        const orderHashToFillAmount: OrderHashToFillAmount = {};
        for (const transaction of transactions) {
            const relevantOrders = _.filter(transaction.orders, o => _.includes(orderHashes, o.hash));
            for (const relevantOrder of relevantOrders) {
                const fillAmountEntity = _.find(
                    transaction.takerAssetFillAmounts,
                    a => a.orderHash === relevantOrder.hash,
                );
                if (fillAmountEntity === undefined) {
                    // We don't expect this condition to ever hit
                    throw new Error(`There should always be a fillAmount for every order.`);
                }
                const existingFillAmountIfExists = orderHashToFillAmount[relevantOrder.hash];
                orderHashToFillAmount[relevantOrder.hash] =
                    existingFillAmountIfExists === undefined
                        ? fillAmountEntity.takerAssetFillAmount
                        : existingFillAmountIfExists.plus(fillAmountEntity.takerAssetFillAmount);
            }
        }
        return orderHashToFillAmount;
    },
    async getOutstandingSignaturesByOrdersAsync(
        coordinatorOrders: OrderWithoutExchangeAddress[],
    ): Promise<OutstandingSignature[]> {
        const coordinatorOrderHashes = _.map(coordinatorOrders, o => orderModel.getHash(o));
        const transactions = await transactionModel.findByOrdersAsync(coordinatorOrders, { isUnexpired: true });
        const outstandingSignatures: OutstandingSignature[] = [];
        _.each(transactions, transaction => {
            _.each(transaction.orders, order => {
                if (_.includes(coordinatorOrderHashes, order.hash)) {
                    const fillAmount = _.find(transaction.takerAssetFillAmounts, { orderHash: order.hash });
                    if (fillAmount === undefined) {
                        throw new Error(
                            `Unexpected failure. Found order in transaction without corresponding fillAmount: ${
                                order.hash
                            }`,
                        );
                    }
                    outstandingSignatures.push({
                        orderHash: order.hash,
                        signature: transaction.signature,
                        expirationTimeSeconds: transaction.expirationTimeSeconds,
                        takerAssetFillAmount: fillAmount.takerAssetFillAmount,
                    });
                }
            });
        });
        return outstandingSignatures;
    },
};
