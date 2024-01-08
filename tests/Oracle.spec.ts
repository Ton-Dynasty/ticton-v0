import { watch } from 'fs';
import { Alarm } from '../build/Oracle/tact_Alarm';
import { Blockchain, SandboxContract, TreasuryContract, printTransactionFees } from '@ton-community/sandbox';
import { Address, Cell, beginCell, toNano } from 'ton-core';
import { Chime, JettonTransfer, OracleV0, Refund, Reset, Tock, storeRefund } from '../wrappers/Oracle_OracleV0';
import { Ring, Mute, Chronoshift } from '../wrappers/Oracle_OracleV0';
import { ExampleJettonMaster } from '../wrappers/Jetton_ExampleJettonMaster';
import { ExampleJettonWallet } from './../build/Jetton/tact_ExampleJettonWallet';
import Decimal from 'decimal.js';
import { float, toToken, int } from './utils';
import '@ton-community/test-utils';
import { RewardJettonWallet } from '../build/Oracle/tact_RewardJettonWallet';

const QUOTEASSET_DECIMALS = 6;
const BASEASSET_DECIMALS = 9;
const GAS_FEE = toNano('1');
const MIN_BASEASSET_THRESHOLD = toNano('1');
const REWARD_JETTON_CONTENT = beginCell().endCell();

const toUSDT = (amount: number | string | Decimal) => toToken(amount, QUOTEASSET_DECIMALS);
const toTON = (amount: number | string | Decimal) => toToken(amount, BASEASSET_DECIMALS);
const toBigInt = (amount: number | string | Decimal) => BigInt(new Decimal(amount).floor().toString());

interface EstimateResult {
    newPrice: Decimal; // the new price of baseAsset (should be float format)
    needBaseAsset: Decimal; // the minimum amount of baseAsset that user needs to bring
    needQuoteAsset: Decimal; // the minimum amount of quoteAsset that user needs to bring
    refundBaseAsset: Decimal; // the amount of baseAsset that oracle will refund to the caller (overestimated), if sendBaseAsset is not provided, this value will be 0
    refundQuoteAsset: Decimal; // the amount of quoteAsset that oracle will refund to the caller (overestimated), if sendQuoteAsset is not provided, this value will be 0
}

describe('Oracle', () => {
    let blockchain: Blockchain;
    let oracle: SandboxContract<OracleV0>;
    let owner: SandboxContract<TreasuryContract>;
    let watchmaker: SandboxContract<TreasuryContract>;
    let jettonMaster: SandboxContract<ExampleJettonMaster>;
    let zero_address: Address = new Address(0, Buffer.alloc(32));
    async function initializeOracle(oracle: SandboxContract<OracleV0>, owner: SandboxContract<TreasuryContract>) {
        const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        const initResult = await oracle.send(
            owner.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'Initialize',
                baseAssetWallet: zero_address,
                quoteAssetWallet: oracleWalletAddress,
                rewardJettonContent: REWARD_JETTON_CONTENT,
            }
        );
        return initResult;
    }

    async function mintToken(
        jettonMaster: SandboxContract<ExampleJettonMaster>,
        watchmaker: SandboxContract<TreasuryContract>
    ) {
        return await jettonMaster.send(watchmaker.getSender(), { value: toNano('1') }, 'Mint:1');
    }

    /**
     *
     * @param alarmIndex The index of alarm timekeeper want to wind
     * @param newBaseAssetPrice The price of baseAsset, e.g. 2.5 means 1 ton = 2.5 usdt
     * @param buyNum The amount of scales to buy, default to 1
     * @param config The configuration for the estimation
     * @returns The estimation result
     */
    const estimate = async (
        alarmIndex: bigint,
        newBaseAssetPrice: string,
        buyNum: number = 1,
        config?: {
            sendBaseAsset?: number;
            sendQuoteAsset?: number;
            extraFees?: number;
        }
    ): Promise<EstimateResult> => {
        const newPrice = float(newBaseAssetPrice).mul(toUSDT(1)).divToInt(toTON(1));
        const extraFees = config?.extraFees ? toTON(config?.extraFees) : toTON('1');
        const alarmContract = blockchain.openContract(Alarm.fromAddress(await oracle.getGetAlarmAddress(alarmIndex)));
        const oldPrice = new Decimal((await alarmContract.getGetBaseAssetPrice()).toString());

        let needBaseAsset: Decimal;
        let needQuoteAsset: Decimal;
        let refundBaseAsset: Decimal;
        let refundQuoteAsset: Decimal;

        if (newPrice.gt(oldPrice)) {
            // Timekeeper will pay quoteAsset and buy baseAsset
            needQuoteAsset = int(
                newPrice
                    .mul(buyNum << 1)
                    .mul(MIN_BASEASSET_THRESHOLD.toString())
                    .add(oldPrice.mul(buyNum).mul(MIN_BASEASSET_THRESHOLD.toString()))
            );
            needBaseAsset = new Decimal(buyNum).mul(MIN_BASEASSET_THRESHOLD.toString()).add(extraFees);
        } else {
            // Timekeeper will pay baseAsset and buy quoteAsset
            needQuoteAsset = int(
                newPrice
                    .mul(buyNum << 1)
                    .mul(MIN_BASEASSET_THRESHOLD.toString())
                    .sub(oldPrice.mul(buyNum).mul(MIN_BASEASSET_THRESHOLD.toString()))
            );
            needBaseAsset = new Decimal(buyNum).mul(3).mul(MIN_BASEASSET_THRESHOLD.toString()).add(extraFees);
        }
        refundBaseAsset = new Decimal(config?.sendBaseAsset ?? needBaseAsset).sub(needBaseAsset);
        refundQuoteAsset = new Decimal(config?.sendQuoteAsset ?? needQuoteAsset).sub(needQuoteAsset);
        if (needQuoteAsset.lt(0)) {
            //console.log('needQuoteAsset is less than 0, add to refundQuoteAsset');
            refundQuoteAsset = refundQuoteAsset.add(needQuoteAsset);
        }
        if (refundBaseAsset.lt(0) || refundQuoteAsset.lt(0)) {
            console.error('refundBaseAsset or refundQuoteAsset is less than 0, return all funds');
            refundBaseAsset = config?.sendBaseAsset ? new Decimal(config.sendBaseAsset) : needBaseAsset;
            refundQuoteAsset = config?.sendQuoteAsset ? new Decimal(config.sendQuoteAsset) : needQuoteAsset;
        }
        refundBaseAsset = refundBaseAsset.add(extraFees.sub(toTON(0.0324)));
        return {
            newPrice,
            needBaseAsset,
            needQuoteAsset,
            refundBaseAsset,
            refundQuoteAsset,
        };
    };

    /**
     *
     * @param watchmaker The caller of this function to trigger the tick msg
     * @param oracle The oracle contract
     * @param quoteAssetToTransfer The amount of quoteAsset to transfer, e.g. then rawQuoteAssetAmount = 10 for 10 usdt
     * @param baseAssetToTransfer The amount of baseAsset to transfer, for tick msg, it's always 1 in the first time
     * @param expireAt The lifetime of this price, e.g. 1734022044
     * @param extraFees The extra fees to pay for the calculation in the oracle contract
     */
    async function tickInJettonTransfer(
        watchmaker: SandboxContract<TreasuryContract>,
        oracle: SandboxContract<OracleV0>,
        quoteAssetToTransfer: number,
        baseAssetToTransfer: number = 1,
        expireAt: number = blockchain.now!! + 1000,
        extraFees: number = 2,
        index: bigint = 1n
    ) {
        const baseAssetPrice = float(toUSDT(quoteAssetToTransfer)).divToInt(toTON(baseAssetToTransfer));
        const quoteAssetTransferred = toUSDT(quoteAssetToTransfer);
        const forwardTonAmount = float(quoteAssetTransferred).div(baseAssetPrice).add(toTON(extraFees));
        const forwardInfo: Cell = beginCell()
            .storeUint(0, 8)
            .storeUint(expireAt, 256)
            .storeUint(toBigInt(baseAssetPrice), 256)
            .endCell();

        const jettonTransfer: JettonTransfer = {
            $$type: 'JettonTransfer',
            query_id: 0n,
            amount: toBigInt(quoteAssetTransferred),
            destination: oracle.address,
            response_destination: watchmaker.address,
            custom_payload: null,
            forward_ton_amount: toBigInt(forwardTonAmount),
            forward_payload: beginCell().storeRef(forwardInfo).endCell(),
        };

        const watchmakerWalletAddress = await jettonMaster.getGetWalletAddress(watchmaker.address);
        const watchmakerJettonContract = blockchain.openContract(
            ExampleJettonWallet.fromAddress(watchmakerWalletAddress)
        );

        const transferResult = await watchmakerJettonContract.send(
            watchmaker.getSender(),
            { value: toBigInt(forwardTonAmount) + GAS_FEE },
            jettonTransfer
        );

        // For test: Should send Jetton back if currentTimestamp > expireAt
        if (expireAt != blockchain.now!! + 1000 || baseAssetToTransfer != 1 || index != 1n) {
            return transferResult;
        }
        //printTransactionFees(transferResult.transactions);

        let oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        // Check that watchmaker send JettonTransfer msg to her jetton wallet
        expect(transferResult.transactions).toHaveTransaction({
            from: watchmaker.address,
            to: watchmakerWalletAddress,
            success: true,
        });

        // Check that watchmaker's jetton wallet send JettonInternalTransfer msg to Bob's jetton wallet
        expect(transferResult.transactions).toHaveTransaction({
            from: watchmakerWalletAddress,
            to: oracleWalletAddress,
            success: true,
        });

        // Check that oracle's jetton wallet send JettonTransferNotification msg to oracle
        expect(transferResult.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: oracle.address,
            success: true,
        });

        let AlarmAddress = await oracle.getGetAlarmAddress(0n);
        //Check that oracle build alarm successfully
        expect(transferResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: AlarmAddress,
            success: true,
        });

        // Check that alarm count is 1
        let alarmIndex = await oracle.getTotalAmount();
        expect(alarmIndex).toEqual(index);

        // Check that alarm send build alarm msg to watchmaker
        expect(transferResult.transactions).toHaveTransaction({
            from: AlarmAddress,
            to: watchmaker.address,
            success: true,
        });

        const alarm0 = blockchain.openContract(await Alarm.fromAddress(AlarmAddress));
        // Check that watchmaker is watchmaker
        let watchmakerAddress = await alarm0.getGetWatchmaker();
        expect(watchmakerAddress.toString()).toEqual(watchmaker.address.toString());

        // Check that baseAssetScale is 1
        let baseAssetScale = await alarm0.getGetBaseAssetScale();
        expect(baseAssetScale).toEqual(1n);

        // Check that quoteAssetScale is 1
        let quoteAssetScale = await alarm0.getGetQuoteAssetScale();
        expect(quoteAssetScale).toEqual(1n);

        // Check that remainScale is 1
        let remainScale = await alarm0.getGetRemainScale();
        expect(remainScale).toEqual(1n);

        return transferResult;
    }

    /**
     *
     * @param timekeeper The caller of this function to trigger the tick msg
     * @param oracle The oracle contract
     * @param alarmIndex The index of alarm timekeeper want to wind
     * @param buyNum The amount of scales to buy
     * @param newPrice The price of baseAsset, e.g. 2.5 means 1 ton = 2.5 usdt
     * @param baseAssetDelta The amount of baseAsset to transfer extra for wind msg
     * @param quoteAssetDelta The amount of quoteAsset to transfer extra for wind msg
     * @param config The configuration for the estimation function
     */
    async function windInJettonTransfer(
        timekeeper: SandboxContract<TreasuryContract>,
        oracle: SandboxContract<OracleV0>,
        alarmIndex: bigint,
        buyNum: number,
        newPrice: string,
        baseAssetDelta: number = 0,
        quoteAssetDelta: number = 0,
        config?: {
            sendBaseAsset?: number;
            sendQuoteAsset?: number;
            extraFees?: number;
            defaultEstimateResult?: EstimateResult;
        }
    ) {
        let op = 1; // 1 means wind
        let estimateResult: EstimateResult = {
            newPrice: new Decimal(0),
            needBaseAsset: toTON(10),
            needQuoteAsset: new Decimal(0),
            refundBaseAsset: new Decimal(0),
            refundQuoteAsset: new Decimal(0),
        };
        try {
            estimateResult = await estimate(alarmIndex, newPrice, buyNum, config);
        } catch (err) {
            estimateResult = config?.defaultEstimateResult ?? estimateResult;
            //console.error(err)
        }
        //console.log('estimateResult ',estimateResult)
        const forwardInfo: Cell = beginCell()
            .storeUint(op, 8)
            .storeUint(alarmIndex, 256)
            .storeUint(buyNum, 32)
            .storeUint(toBigInt(estimateResult.newPrice), 256)
            .endCell();
        const jettonTransfer: JettonTransfer = {
            $$type: 'JettonTransfer',
            query_id: 0n,
            amount: toBigInt(estimateResult.needQuoteAsset) + toBigInt(toUSDT(quoteAssetDelta.toString())),
            destination: oracle.address,
            response_destination: timekeeper.address,
            custom_payload: null,
            forward_ton_amount: toBigInt(estimateResult.needBaseAsset) + toNano(baseAssetDelta),
            forward_payload: beginCell().storeRef(forwardInfo).endCell(),
        };

        // watchmaker's jetton wallet address
        const timekeeperWalletAddress = await jettonMaster.getGetWalletAddress(timekeeper.address);
        // watchmaker's jetton wallet
        const timekeeperJettonContract = blockchain.openContract(
            ExampleJettonWallet.fromAddress(timekeeperWalletAddress)
        );
        const windResult = await timekeeperJettonContract.send(
            timekeeper.getSender(),
            {
                value:
                    toBigInt(estimateResult.needBaseAsset) +
                    toNano(baseAssetDelta) +
                    BigInt(config?.extraFees ?? GAS_FEE),
            },
            jettonTransfer
        );

        return { windResult, estimateResult };
    }

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = Math.floor(Date.now() / 1000);
        owner = await blockchain.treasury('owner');
        watchmaker = await blockchain.treasury('watchmaker');
        blockchain.now = Math.floor(Date.now() / 1000);
        const jetton_content: Cell = beginCell().endCell();
        jettonMaster = blockchain.openContract(await ExampleJettonMaster.fromInit(owner.address, jetton_content));

        oracle = blockchain.openContract(await OracleV0.fromInit(zero_address, jettonMaster.address));
        const deployResult = await oracle.send(
            owner.getSender(),
            {
                value: toNano('10'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            }
        );
        expect(deployResult.transactions).toHaveTransaction({
            from: owner.address,
            to: oracle.address,
            deploy: true,
            success: true,
        });

        const masterDeployResult = await jettonMaster.send(
            owner.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            }
        );

        expect(masterDeployResult.transactions).toHaveTransaction({
            from: owner.address,
            to: jettonMaster.address,
            deploy: true,
            success: true,
        });
    });

    it('Should deploy', async () => {
        // the check is done inside beforeEach
        // blockchain and oracle are ready to use
    });

    it('Tick Test: Should watchmaker sends tick msg to oracle', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetToTransfer = 4; // expected to transfer 10 usdt
        const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        const jettonTransferResult = await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer);
        expect(jettonTransferResult.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: oracle.address,
            success: true,
        });
        // Check that alarm count is 1
        let alarmIndex = await oracle.getTotalAmount();
        expect(alarmIndex).toEqual(1n);
    });

    it('Tick Test: Should fail if message is not from oracle', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetToTransfer = 10; // 10usdt
        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer);

        let AlarmAddress = await oracle.getGetAlarmAddress(0n);
        const tockMsg: Tock = {
            $$type: 'Tock',
            scale: 1n,
            createdAt: 0n,
            watchmaker: watchmaker.address,
            baseAssetPrice: BigInt(toUSDT(4).toNumber()),
        };

        const alarm0 = blockchain.openContract(await Alarm.fromAddress(AlarmAddress));
        const tockResult = await alarm0.send(
            watchmaker.getSender(),
            {
                value: toNano('10'),
            },
            tockMsg
        );
        // should fail because msg is not from oracle
        expect(tockResult.transactions).toHaveTransaction({
            from: watchmaker.address,
            to: AlarmAddress,
            success: false,
        });
    });

    it('Tick Test: Should send Jetton back if currentTimestamp > expireAt', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetToTransfer = 10; // 10usdt
        const result = await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer, 1, blockchain.now!! - 1000);
        const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        const watchmakerWalletAddress = await jettonMaster.getGetWalletAddress(watchmaker.address);
        // Check that oracle send Jetton Transfer message to refund jetton to watchmaker
        expect(result.transactions).toHaveTransaction({
            from: oracle.address,
            to: oracleWalletAddress,
            success: true,
        });

        // Check that oracle Wallet send JettonInternalTransfer msg to watchmaker's jetton wallet
        expect(result.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: watchmakerWalletAddress,
            success: true,
        });
    });

    it('Tick Test: Should revert if baseAssetAmount is too small', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetToTransfer = 4; // expected to transfer 10 usdt
        const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        const baseAssetToTransfer = 0.5; // 0.5 ton
        const result = await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer, baseAssetToTransfer);

        expect(result.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: oracle.address,
            exitCode: 62368, // baseAssetAmount is too small
        });
    });

    it('Tick Test: Should revert if insufficient funds to pay for the gas', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        const quoteAssetToTransfer = 4; // expected to transfer 10 usdt
        const baseAssetToTransfer = 1; // 0.5 ton
        const baseAssetPrice = float(toUSDT(quoteAssetToTransfer)).divToInt(toTON(baseAssetToTransfer));
        const quoteAssetTransferred = toUSDT(quoteAssetToTransfer);
        const forwardTonAmount = float(quoteAssetTransferred).div(baseAssetPrice);
        const forwardInfo: Cell = beginCell()
            .storeUint(0, 8)
            .storeUint(blockchain.now!! + 1000, 256)
            .storeUint(toBigInt(baseAssetPrice), 256)
            .endCell();

        const jettonTransfer: JettonTransfer = {
            $$type: 'JettonTransfer',
            query_id: 0n,
            amount: toBigInt(quoteAssetTransferred),
            destination: oracle.address,
            response_destination: watchmaker.address,
            custom_payload: null,
            forward_ton_amount: toBigInt(forwardTonAmount),
            forward_payload: beginCell().storeRef(forwardInfo).endCell(),
        };

        const watchmakerWalletAddress = await jettonMaster.getGetWalletAddress(watchmaker.address);
        const watchmakerJettonContract = blockchain.openContract(
            ExampleJettonWallet.fromAddress(watchmakerWalletAddress)
        );

        const transferResult = await watchmakerJettonContract.send(
            watchmaker.getSender(),
            { value: toBigInt(forwardTonAmount) + GAS_FEE },
            jettonTransfer
        );
        const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        expect(transferResult.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: oracle.address,
            exitCode: 53238, // insufficient funds to pay for the gas
        });
    });

    it('Tick Test: Should return funds if remaining ton is sufficient to pay the gas', async () => {
        // TODO: the code in oracle for now is not support "Invalid jetton token received" and "Amount is lower than the lowerbound (theshold for baseAsset + gas)"
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetToTransfer = 10; // 10usdt
        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer);
    });

    it('Wind Test: Should timekeeper buy base asset', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 4; // 4usdt
        let oracleBalanceBefore = await oracle.getGetMyBalance();
        let oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        let oracleJettonContract = blockchain.openContract(await ExampleJettonWallet.fromAddress(oracleWalletAddress));
        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);
        let orcleJettonBalanceAfter = (await oracleJettonContract.getGetWalletData()).balance;
        let oracleBalanceAfter = await oracle.getGetMyBalance();
        expect(oracleBalanceAfter - oracleBalanceBefore).toBeGreaterThan(toNano('0.99')); // This 0.99 ton is the watchmaker's deposit base asset
        expect(orcleJettonBalanceAfter).toEqual(4000000n); // This 4 USDT is the watchmaker's deposit quote asset
        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);
        // Timekeeper send wind msg to oracle
        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');
        await mintToken(jettonMaster, timekeeper);
        let alarmIndex = 0n;
        let buyNum = 1;
        let orcleJettonBalanceBefore = (await oracleJettonContract.getGetWalletData()).balance;
        const { windResult } = await windInJettonTransfer(timekeeper, oracle, alarmIndex, buyNum, '5');
        orcleJettonBalanceAfter = (await oracleJettonContract.getGetWalletData()).balance;
        oracleBalanceAfter = await oracle.getGetMyBalance();
        oracleBalanceAfter = await oracle.getGetMyBalance();
        expect(oracleBalanceAfter).toBeGreaterThan(toNano('1.99')); // This 1.99 ton is the timekeeper's deposit base asset
        expect(orcleJettonBalanceAfter - orcleJettonBalanceBefore).toEqual(13999999n); // This 10 USDT is the timekeeper's deposit quote asset , 4 USDT is the amount that timekeeper buy watchmaker's base asset

        // watchmaker's jetton wallet address
        const timekeeperWalletAddress = await jettonMaster.getGetWalletAddress(timekeeper.address);
        // Check that timekeeper send JettonTransfer msg to her jetton wallet
        expect(windResult.transactions).toHaveTransaction({
            from: timekeeper.address,
            to: timekeeperWalletAddress,
            success: true,
        });

        // Check that timekeeper's jetton wallet send JettonInternalTransfer msg to oracle's jetton wallet
        expect(windResult.transactions).toHaveTransaction({
            from: timekeeperWalletAddress,
            to: oracleWalletAddress,
            success: true,
        });

        // Check that oracle's jetton wallet send JettonTransferNotification msg to oracle
        expect(windResult.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: oracle.address,
            success: true,
        });

        // Check that oracle send Reset msg to Alarm0
        let AlarmAddress = await oracle.getGetAlarmAddress(0n);
        let alarm0 = blockchain.openContract(Alarm.fromAddress(AlarmAddress));
        expect(windResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: AlarmAddress,
            success: true,
        });

        // Check that Alarm contract send Chime msg to oracle
        expect(windResult.transactions).toHaveTransaction({
            from: AlarmAddress,
            to: oracle.address,
            success: true,
        });

        // Check that oracle build a new Alarm1 successfully
        let Alarm1Address = await oracle.getGetAlarmAddress(1n);
        expect(windResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: Alarm1Address,
            success: true,
        });

        // Return the remaining funds back to the Timekeeper
        expect(windResult.transactions).toHaveTransaction({
            from: Alarm1Address,
            to: timekeeper.address,
            success: true,
        });

        // Check that Oracle refund base asset to timekeeper
        expect(windResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: timekeeper.address,
            success: true,
        });

        // Check that baseAssetScale is 0
        let baseAssetScale = await alarm0.getGetBaseAssetScale();
        expect(baseAssetScale).toEqual(0n);

        // Check that quoteAssetScale is 2
        let quoteAssetScale = await alarm0.getGetQuoteAssetScale();
        expect(quoteAssetScale).toEqual(2n);

        // Check that remainScale is 0
        let remainScale = await alarm0.getGetRemainScale();
        expect(remainScale).toEqual(0n);

        // Check that alarm count is 2 (Timekeeper will build a new alarm)
        alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(2n);

        let AlarmAddress2 = await oracle.getGetAlarmAddress(1n);
        let alarm02 = blockchain.openContract(await Alarm.fromAddress(AlarmAddress2));
        // Check that baseAssetScale is 0
        let baseAssetScale2 = await alarm02.getGetBaseAssetScale();
        expect(baseAssetScale2).toEqual(2n);

        // Check that quoteAssetScale is 2
        let quoteAssetScale2 = await alarm02.getGetQuoteAssetScale();
        expect(quoteAssetScale2).toEqual(2n);

        // Check that remainScale is 0
        let remainScale2 = await alarm02.getGetRemainScale();
        expect(remainScale2).toEqual(2n);
    });

    it('Wind Test: Should timekeeper wind but do not have to transfer any quote asset to oracle in the first place', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 2; // 4usdt
        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);
        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);
        // Timekeeper send wind msg to oracle
        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');
        await mintToken(jettonMaster, timekeeper);
        let alarmIndex = 0n;
        let buyNum = 1;
        await windInJettonTransfer(timekeeper, oracle, alarmIndex, buyNum, '3');
        let alarmIndex2 = 1n;
        let buyNum2 = 1;

        let timekeeperWalletAddress = await jettonMaster.getGetWalletAddress(timekeeper.address);
        let timekeeprWallet = blockchain.openContract(await ExampleJettonWallet.fromAddress(timekeeperWalletAddress));
        let balacenceBefore = (await timekeeprWallet.getGetWalletData()).balance;

        let config = {
            sendQuoteAsset: 30000000,
        };
        let { windResult: windResult2, estimateResult } = await windInJettonTransfer(
            timekeeper,
            oracle,
            alarmIndex2,
            buyNum2,
            '1',
            0,
            30,
            config
        );
        let balacenceAfter = (await timekeeprWallet.getGetWalletData()).balance;

        // Check that oracle send quoteAsset to timekeeper if the needQuoteAssetAmount < 0
        let oralceWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        expect(windResult2.transactions).toHaveTransaction({
            from: oralceWalletAddress,
            to: timekeeperWalletAddress,
            success: true,
        });

        // Check that timekeeper's balance should be increase 1u, because needQuoteAsset is -1u, oracle will transfer 1u to timekeeper
        expect(balacenceAfter - balacenceBefore).toBeGreaterThan(-1n * toBigInt(estimateResult.needQuoteAsset));
    });

    it('Wind Test: Should refund base asset back to timekeeper if he bring too much base asset', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 4; // 4usdt
        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);
        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);
        // Timekeeper send wind msg to oracle
        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');
        await mintToken(jettonMaster, timekeeper);
        let alarmIndex = 0n;
        let buyNum = 1;
        let sendBaseAsset = 2080000000;
        let config = {
            sendBaseAsset: sendBaseAsset,
            extraFees: 1,
        };
        let beforeBalance = await timekeeper.getBalance();
        const { windResult, estimateResult } = await windInJettonTransfer(
            timekeeper,
            oracle,
            alarmIndex,
            buyNum,
            '5',
            1,
            0,
            config
        );
        let afterBalance = await timekeeper.getBalance();
        let refundBaseAsset = estimateResult.refundBaseAsset;
        let sendBackAmountInAlarm = 0.088; // after alarm initialized, it will return the remaining funds back to the watchmaker
        expect(Number(beforeBalance - afterBalance) / 1000000000).toBeCloseTo(
            sendBackAmountInAlarm + (sendBaseAsset - Number(refundBaseAsset)) / 1000000000,
            1
        );

        // watchmaker's jetton wallet address
        const timekeeperWalletAddress = await jettonMaster.getGetWalletAddress(timekeeper.address);

        // Check that timekeeper send JettonTransfer msg to her jetton wallet
        expect(windResult.transactions).toHaveTransaction({
            from: timekeeper.address,
            to: timekeeperWalletAddress,
            success: true,
        });

        const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        // Check that timekeeper's jetton wallet send JettonInternalTransfer msg to oracle's jetton wallet
        expect(windResult.transactions).toHaveTransaction({
            from: timekeeperWalletAddress,
            to: oracleWalletAddress,
            success: true,
        });

        // Check that oracle's jetton wallet send JettonTransferNotification msg to oracle
        expect(windResult.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: oracle.address,
            success: true,
        });

        // Check that oracle send Reset msg to Alarm0
        let AlarmAddress = await oracle.getGetAlarmAddress(0n);
        let alarm0 = blockchain.openContract(Alarm.fromAddress(AlarmAddress));
        expect(windResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: AlarmAddress,
            success: true,
        });

        // Check that Alarm contract send Chime msg to oracle
        expect(windResult.transactions).toHaveTransaction({
            from: AlarmAddress,
            to: oracle.address,
            success: true,
        });

        // Check that oracle build a new Alarm1 successfully
        let Alarm1Address = await oracle.getGetAlarmAddress(1n);
        expect(windResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: Alarm1Address,
            success: true,
        });

        // Return the remaining funds back to the Timekeeper
        expect(windResult.transactions).toHaveTransaction({
            from: Alarm1Address,
            to: timekeeper.address,
            success: true,
        });

        // Check that baseAssetScale is 0
        let baseAssetScale = await alarm0.getGetBaseAssetScale();
        expect(baseAssetScale).toEqual(0n);

        // Check that quoteAssetScale is 2
        let quoteAssetScale = await alarm0.getGetQuoteAssetScale();
        expect(quoteAssetScale).toEqual(2n);

        // Check that remainScale is 0
        let remainScale = await alarm0.getGetRemainScale();
        expect(remainScale).toEqual(0n);

        // Check that alarm count is 2 (Timekeeper will build a new alarm)
        alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(2n);

        let AlarmAddress2 = await oracle.getGetAlarmAddress(1n);
        let alarm02 = blockchain.openContract(await Alarm.fromAddress(AlarmAddress2));
        // Check that baseAssetScale is 0
        let baseAssetScale2 = await alarm02.getGetBaseAssetScale();
        expect(baseAssetScale2).toEqual(2n);

        // Check that quoteAssetScale is 2
        let quoteAssetScale2 = await alarm02.getGetQuoteAssetScale();
        expect(quoteAssetScale2).toEqual(2n);

        // Check that remainScale is 0
        let remainScale2 = await alarm02.getGetRemainScale();
        expect(remainScale2).toEqual(2n);
    });

    it('Wind Test: Should refund quote asset back to timekeeper if he bring too much quote asset', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 4; // 4usdt
        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);
        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);
        // Timekeeper send wind msg to oracle
        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');
        await mintToken(jettonMaster, timekeeper);
        let alarmIndex = 0n;
        let buyNum = 1;
        let config = {
            sendQuoteAsset: 20000000,
        };
        const { windResult, estimateResult } = await windInJettonTransfer(
            timekeeper,
            oracle,
            alarmIndex,
            buyNum,
            '5',
            0,
            20,
            config
        );

        // watchmaker's jetton wallet address
        const timekeeperWalletAddress = await jettonMaster.getGetWalletAddress(timekeeper.address);

        // Check that timekeeper send JettonTransfer msg to her jetton wallet
        expect(windResult.transactions).toHaveTransaction({
            from: timekeeper.address,
            to: timekeeperWalletAddress,
            success: true,
        });

        const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        // Check that timekeeper's jetton wallet send JettonInternalTransfer msg to oracle's jetton wallet
        expect(windResult.transactions).toHaveTransaction({
            from: timekeeperWalletAddress,
            to: oracleWalletAddress,
            success: true,
        });

        // Check that oracle's jetton wallet send JettonTransferNotification msg to oracle
        expect(windResult.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: oracle.address,
            success: true,
        });

        // Check that oracle send Reset msg to Alarm0
        let AlarmAddress = await oracle.getGetAlarmAddress(0n);
        let alarm0 = blockchain.openContract(Alarm.fromAddress(AlarmAddress));
        expect(windResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: AlarmAddress,
            success: true,
        });

        // Check that Alarm contract send Chime msg to oracle
        expect(windResult.transactions).toHaveTransaction({
            from: AlarmAddress,
            to: oracle.address,
            success: true,
        });

        // Check that oracle build a new Alarm1 successfully
        let Alarm1Address = await oracle.getGetAlarmAddress(1n);
        expect(windResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: Alarm1Address,
            success: true,
        });

        // Return the remaining funds back to the Timekeeper
        expect(windResult.transactions).toHaveTransaction({
            from: Alarm1Address,
            to: timekeeper.address,
            success: true,
        });

        // Check that Oracle refund quote asset to timekeeper, TODO: Add refund msg at body
        expect(windResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: oracleWalletAddress,
            success: true,
        });

        // Check that baseAssetScale is 0
        let baseAssetScale = await alarm0.getGetBaseAssetScale();
        expect(baseAssetScale).toEqual(0n);

        // Check that quoteAssetScale is 2
        let quoteAssetScale = await alarm0.getGetQuoteAssetScale();
        expect(quoteAssetScale).toEqual(2n);

        // Check that remainScale is 0
        let remainScale = await alarm0.getGetRemainScale();
        expect(remainScale).toEqual(0n);

        // Check that alarm count is 2 (Timekeeper will build a new alarm)
        alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(2n);

        let AlarmAddress2 = await oracle.getGetAlarmAddress(1n);
        let alarm02 = blockchain.openContract(await Alarm.fromAddress(AlarmAddress2));
        // Check that baseAssetScale is 0
        let baseAssetScale2 = await alarm02.getGetBaseAssetScale();
        expect(baseAssetScale2).toEqual(2n);

        // Check that quoteAssetScale is 2
        let quoteAssetScale2 = await alarm02.getGetQuoteAssetScale();
        expect(quoteAssetScale2).toEqual(2n);

        // Check that remainScale is 0
        let remainScale2 = await alarm02.getGetRemainScale();
        expect(remainScale2).toEqual(2n);
    });

    it('Wind Test: Should buy base asset with not enough quote asset', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 4; // 4usdt
        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);
        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);
        // Timekeeper send wind msg to oracle
        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');
        await mintToken(jettonMaster, timekeeper);
        let alarmIndex = 0n;
        let buyNum = 1;
        const { windResult, estimateResult } = await windInJettonTransfer(
            timekeeper,
            oracle,
            alarmIndex,
            buyNum,
            '5',
            -1
        );

        // watchmaker's jetton wallet address
        const timekeeperWalletAddress = await jettonMaster.getGetWalletAddress(timekeeper.address);

        // Check that timekeeper send JettonTransfer msg to her jetton wallet
        expect(windResult.transactions).toHaveTransaction({
            from: timekeeper.address,
            to: timekeeperWalletAddress,
            success: true,
        });

        const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        // Check that timekeeper's jetton wallet send JettonInternalTransfer msg to oracle's jetton wallet
        expect(windResult.transactions).toHaveTransaction({
            from: timekeeperWalletAddress,
            to: oracleWalletAddress,
            success: true,
        });

        // Check that oracle's jetton wallet send JettonTransferNotification msg to oracle
        expect(windResult.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: oracle.address,
            success: true,
        });

        // Check that oracle send Reset msg to Alarm0
        let AlarmAddress = await oracle.getGetAlarmAddress(0n);
        expect(windResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: AlarmAddress,
            success: true,
        });

        let refundMsg: Refund = {
            $$type: 'Refund',
            alarmIndex: alarmIndex,
            refundQuoteAssetAmount: toBigInt(estimateResult.needQuoteAsset),
            receiver: timekeeper.address,
        };
        const refundPayload = beginCell();
        const builderFunc = storeRefund(refundMsg);
        builderFunc(refundPayload);

        // Check that Alarm contract send Refund msg to oracle
        expect(windResult.transactions).toHaveTransaction({
            from: AlarmAddress,
            to: oracle.address,
            body: refundPayload.endCell(),
            success: true,
        });

        //Check that oracle send JettonTransfer msg to oracle's jetton wallet
        expect(windResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: oracleWalletAddress,
            success: true,
        });

        // Check that oracle's jetton wallet send JettonInternalTransfer msg to timekeeper's jetton wallet
        expect(windResult.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: timekeeperWalletAddress,
            success: true,
        });
    });

    it('Wind Test: Should return funds if alarmIndex is incorrect', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 10; // 10usdt
        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);
        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);
        // Timekeeper send wind msg to oracle
        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');

        // timekeeper's jetton wallet address
        const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        await mintToken(jettonMaster, timekeeper);
        let wrongAlarmIndex = 10n;
        let buyNum = 1;
        let { windResult } = await windInJettonTransfer(timekeeper, oracle, wrongAlarmIndex, buyNum, '10');
        // Fail because alarmIndex is incorrect
        expect(windResult.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: oracle.address,
            success: false,
            exitCode: 37019, // Alarm index is incorrect
        });
    });

    it('Wind Test: Should refund token to timekeeper if self.remainScale < msg.buyNum', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 10; // 10usdt
        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);
        // Timekeeper send wind msg to oracle
        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');

        await mintToken(jettonMaster, timekeeper);
        let alarmIndex = 0n;
        let buyNum = 10;
        let { windResult } = await windInJettonTransfer(timekeeper, oracle, alarmIndex, buyNum, '5');

        let AlarmAddress = await oracle.getGetAlarmAddress(0n);

        // Check that alarm send Refund msg to oracle
        expect(windResult.transactions).toHaveTransaction({
            from: AlarmAddress,
            to: oracle.address,
            success: true,
        });

        // Check that oracle send JettonTransfer msg to oracle's jetton wallet
        let oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        let timekeeperWalletAddress = await jettonMaster.getGetWalletAddress(timekeeper.address);
        expect(windResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: oracleWalletAddress,
            success: true,
        });
        expect(windResult.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: timekeeperWalletAddress,
            success: true,
        });
    });

    it('Wind Test: Should fail transaction if Reset message is not from Oracle', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 10; // 10usdt
        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);

        const resetMsg: Reset = {
            $$type: 'Reset',
            sender: owner.address,
            buyNum: 1n, // The number of scales to buy
            quoteAssetAmount: 1n, // The amount of quoteAsset oracle received
            newBaseAssetPrice: 1n, // The new baseAssetPrice
        };
        let AlarmAddress = await oracle.getGetAlarmAddress(0n);
        const alarm0 = blockchain.openContract(await Alarm.fromAddress(AlarmAddress));
        const tockResult = await alarm0.send(
            watchmaker.getSender(),
            {
                value: toNano('10'),
            },
            resetMsg
        );
        // should fail because msg is not from oracle
        expect(tockResult.transactions).toHaveTransaction({
            from: watchmaker.address,
            to: AlarmAddress,
            success: false,
        });
    });

    it('Wind Test: Should fail transaction if Chime message not came from Alarm contract', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 10; // 10usdt
        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);

        const resetMsg: Chime = {
            $$type: 'Chime',
            alarmIndex: 0n,
            timeKeeper: owner.address,
            newBaseAssetPrice: 1n,
            newScale: 1n,
            refundQuoteAssetAmount: 1n,
            baseAssetPrice: 1n,
            createdAt: 1n,
            remainScale: 1n,
            preserveBaseAssetAmount: 0n,
        };
        const tockResult = await oracle.send(
            owner.getSender(),
            {
                value: toNano('10'),
            },
            resetMsg
        );
        // should fail because msg is not from alarm
        expect(tockResult.transactions).toHaveTransaction({
            from: owner.address,
            to: oracle.address,
            success: false,
        });
    });

    it('Wind Test: Should update price according to the formula in the Chime msg', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 4; // 4usdt
        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);
        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);
        // Timekeeper send wind msg to oracle
        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');
        await mintToken(jettonMaster, timekeeper);
        blockchain!!.now = Math.floor(Date.now() / 1000);
        let alarmIndex = 0n;
        let buyNum = 1;
        let config = {
            extraFees: 1,
        };
        let { windResult } = await windInJettonTransfer(timekeeper, oracle, alarmIndex, buyNum, '5', 0, 0, config);
        // Check that alarm count is 2 (Timekeeper will build a new alarm)
        alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(2n);

        let alarmAddress1 = await oracle.getGetAlarmAddress(1n);
        expect(windResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: alarmAddress1,
            success: true,
        });

        // Timekeeper2 send wind msg to take money from timekeeper1
        let timekeeper2: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper2');
        await mintToken(jettonMaster, timekeeper2);

        blockchain.now = Math.floor(Date.now() / 1000) + 70; // Wating for 70 seconds to pass the verification period

        let alarmIndex2 = 1n;
        let buyNum2 = 1;
        let { windResult: windResult2 } = await windInJettonTransfer(timekeeper2, oracle, alarmIndex2, buyNum2, '6');
        //printTransactionFees(windResult2.transactions);
        let timekeeperWalletAddress2 = await jettonMaster.getGetWalletAddress(timekeeper2.address);

        // Check that after timekeeper wind and he didn't buy all assets, the LatestBaseAssetPrice will be update to the price that miner set
        let latestPrice = await oracle.getGetLatestBaseAssetPrice();
        // console.log("Price: ",Number(latestPrice)/ 2 ** 64 )
        // console.log("Price: ",Number(price) / 2 ** 64)

        expect(Number(latestPrice) / 2 ** 64).toEqual(0.005);

        // Check that timekeeper send JettonTransfer msg to her jetton wallet
        expect(windResult2.transactions).toHaveTransaction({
            from: timekeeper2.address,
            to: timekeeperWalletAddress2,
            success: true,
        });

        const oracleWalletAddress2 = await jettonMaster.getGetWalletAddress(oracle.address);
        // Check that timekeeper's jetton wallet send JettonInternalTransfer msg to oracle's jetton wallet
        expect(windResult2.transactions).toHaveTransaction({
            from: timekeeperWalletAddress2,
            to: oracleWalletAddress2,
            success: true,
        });

        // Check that oracle's jetton wallet send JettonTransferNotification msg to oracle
        expect(windResult2.transactions).toHaveTransaction({
            from: oracleWalletAddress2,
            to: oracle.address,
            success: true,
        });

        // Check that oracle send Reset msg to Alarm1
        expect(windResult2.transactions).toHaveTransaction({
            from: oracle.address,
            to: alarmAddress1,
            success: true,
        });

        // Check that Alarm contract send Chime msg to oracle
        expect(windResult2.transactions).toHaveTransaction({
            from: alarmAddress1,
            to: oracle.address,
            success: true,
        });

        // Check that oracle build a new Alarm2 successfully
        let alarm1Address2 = await oracle.getGetAlarmAddress(2n);
        expect(windResult2.transactions).toHaveTransaction({
            from: oracle.address,
            to: alarm1Address2,
            success: true,
        });

        // Check that Alarm2 baseAssetPrice is new Price
        let alarmAddress2 = await oracle.getGetAlarmAddress(2n);
        let alarm2 = blockchain.openContract(Alarm.fromAddress(alarmAddress2));
        let alarmNewPrice2 = await alarm2.getGetBaseAssetPrice();
        expect(Number(alarmNewPrice2) / 2 ** 64).toEqual(0.006);

        // Check that return the remaining funds back to the Timekeeper2
        expect(windResult2.transactions).toHaveTransaction({
            from: alarm1Address2,
            to: timekeeper2.address,
            success: true,
        });

        // Check that Oracle send standardRefundAmount to timekeeper2
        expect(windResult2.transactions).toHaveTransaction({
            from: oracle.address,
            to: timekeeper2.address,
            success: true,
        });
    });

    it('Wind Test: Should timekeeper buy quoteAsset', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 4; // 4usdt
        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);
        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);
        // Timekeeper send wind msg to oracle
        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');
        await mintToken(jettonMaster, timekeeper);
        let alarmIndex = 0n;
        let buyNum = 1;
        const { windResult, estimateResult } = await windInJettonTransfer(timekeeper, oracle, alarmIndex, buyNum, '3');

        // watchmaker's jetton wallet address
        const timekeeperWalletAddress = await jettonMaster.getGetWalletAddress(timekeeper.address);

        // Check that timekeeper send JettonTransfer msg to her jetton wallet
        expect(windResult.transactions).toHaveTransaction({
            from: timekeeper.address,
            to: timekeeperWalletAddress,
            success: true,
        });

        const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        // Check that timekeeper's jetton wallet send JettonInternalTransfer msg to oracle's jetton wallet
        expect(windResult.transactions).toHaveTransaction({
            from: timekeeperWalletAddress,
            to: oracleWalletAddress,
            success: true,
        });

        // Check that oracle's jetton wallet send JettonTransferNotification msg to oracle
        expect(windResult.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: oracle.address,
            success: true,
        });

        // Check that oracle send Reset msg to Alarm0
        let AlarmAddress = await oracle.getGetAlarmAddress(0n);
        let alarm0 = blockchain.openContract(Alarm.fromAddress(AlarmAddress));
        expect(windResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: AlarmAddress,
            success: true,
        });

        // Check that Alarm contract send Chime msg to oracle
        expect(windResult.transactions).toHaveTransaction({
            from: AlarmAddress,
            to: oracle.address,
            success: true,
        });

        // Check that oracle build a new Alarm1 successfully
        let Alarm1Address = await oracle.getGetAlarmAddress(1n);
        expect(windResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: Alarm1Address,
            success: true,
        });

        // Return the remaining funds back to the Timekeeper
        expect(windResult.transactions).toHaveTransaction({
            from: Alarm1Address,
            to: timekeeper.address,
            success: true,
        });

        // Check that baseAssetScale is 0
        let baseAssetScale = await alarm0.getGetBaseAssetScale();
        expect(baseAssetScale).toEqual(2n);

        // Check that quoteAssetScale is 2
        let quoteAssetScale = await alarm0.getGetQuoteAssetScale();
        expect(quoteAssetScale).toEqual(0n);

        // Check that remainScale is 0
        let remainScale = await alarm0.getGetRemainScale();
        expect(remainScale).toEqual(0n);

        // Check that alarm count is 2 (Timekeeper will build a new alarm)
        alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(2n);

        let AlarmAddress2 = await oracle.getGetAlarmAddress(1n);
        let alarm02 = blockchain.openContract(await Alarm.fromAddress(AlarmAddress2));
        // Check that baseAssetScale is 0
        let baseAssetScale2 = await alarm02.getGetBaseAssetScale();
        expect(baseAssetScale2).toEqual(2n);

        // Check that quoteAssetScale is 2
        let quoteAssetScale2 = await alarm02.getGetQuoteAssetScale();
        expect(quoteAssetScale2).toEqual(2n);

        // Check that remainScale is 0
        let remainScale2 = await alarm02.getGetRemainScale();
        expect(remainScale2).toEqual(2n);
    });

    it('Wind Test: Should buy quote asset with not enough base asset', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 4; // 4usdt
        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);
        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);
        // Timekeeper send wind msg to oracle
        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');
        await mintToken(jettonMaster, timekeeper);
        let alarmIndex = 0n;
        let buyNum = 1;
        const { windResult } = await windInJettonTransfer(timekeeper, oracle, alarmIndex, buyNum, '3', 0, -1);

        // watchmaker's jetton wallet address
        const timekeeperWalletAddress = await jettonMaster.getGetWalletAddress(timekeeper.address);

        // Check that timekeeper send JettonTransfer msg to her jetton wallet
        expect(windResult.transactions).toHaveTransaction({
            from: timekeeper.address,
            to: timekeeperWalletAddress,
            success: true,
        });

        const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        // Check that timekeeper's jetton wallet send JettonInternalTransfer msg to oracle's jetton wallet
        expect(windResult.transactions).toHaveTransaction({
            from: timekeeperWalletAddress,
            to: oracleWalletAddress,
            success: true,
        });

        // Check that oracle's jetton wallet send JettonTransferNotification msg to oracle
        expect(windResult.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: oracle.address,
            success: true,
        });

        // Check that oracle send Reset msg to Alarm0
        let AlarmAddress = await oracle.getGetAlarmAddress(0n);
        expect(windResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: AlarmAddress,
            success: true,
        });

        // Check that Alarm contract send Chime msg to oracle
        expect(windResult.transactions).toHaveTransaction({
            from: AlarmAddress,
            to: oracle.address,
            success: true,
        });

        // Check that Alarm contract send Refund msg to oracle
        expect(windResult.transactions).toHaveTransaction({
            from: AlarmAddress,
            to: oracle.address,
            success: true,
        });

        //Check that oracle send JettonTransfer msg to oracle's jetton wallet
        expect(windResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: oracleWalletAddress,
            success: true,
        });

        // Check that oracle's jetton wallet send JettonInternalTransfer msg to timekeeper's jetton wallet
        expect(windResult.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: timekeeperWalletAddress,
            success: true,
        });
    });

    it('Ring Test: Should fail if alarm index does not exists', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 10; // 10usdt
        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);
        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);
        // Watchmaker should send ring msg to oracle
        let alarmIndex = 10n;
        let ring: Ring = {
            $$type: 'Ring',
            queryID: 0n,
            alarmIndex: alarmIndex,
        };
        let ringResult = await oracle.send(
            watchmaker.getSender(),
            {
                value: toNano('10'),
            },
            ring
        );
        // Should fail because alarmIndex does not exists
        expect(ringResult.transactions).toHaveTransaction({
            from: watchmaker.address,
            to: oracle.address,
            success: false,
        });
    });

    it('Ring Test: Should send Mute message to corresponding Alarm contract', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 10; // 10usdt
        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);
        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);
        // Watchmaker should send ring msg to oracle
        let alarmIndex = 0n;
        let ring: Ring = {
            $$type: 'Ring',
            queryID: 0n,
            alarmIndex: alarmIndex,
        };
        let ringResult = await oracle.send(
            watchmaker.getSender(),
            {
                value: toNano('10'),
            },
            ring
        );

        // Check that oracle send Mute msg to corresponding Alarm contract
        let alarmAddress = await oracle.getGetAlarmAddress(alarmIndex);
        expect(ringResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: alarmAddress,
            success: true,
        });
    });

    it('Ring Test: Should failed if Mute message is not from oracle', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);

        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 10; // 10usdt

        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);

        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);

        // Watchmaker should send ring msg to oracle
        let alarmIndex = 1n;

        let alarmAddress = await oracle.getGetAlarmAddress(alarmIndex);
        let alarmContract = blockchain.openContract(await Alarm.fromAddress(alarmAddress));

        // Timekeeper try to send Mute msg to corresponding Alarm contract
        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');
        let mute: Mute = {
            $$type: 'Mute',
            queryID: 0n,
        };
        let muteResult = await alarmContract.send(
            timekeeper.getSender(),
            {
                value: toNano('10'),
            },
            mute
        );

        // Should fail because msg is not from oracle
        expect(muteResult.transactions).toHaveTransaction({
            from: timekeeper.address,
            to: alarmAddress,
            success: false,
        });
    });

    it('Ring Test: Should alarm contract send Chronoshift to oracle with remaining balance', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);

        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);

        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 10; // 10usdt

        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);

        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);

        // Watchmaker should send ring msg to oracle
        let alarmIndex = 0n;

        let alarmAddress = await oracle.getGetAlarmAddress(alarmIndex);
        let alarmContract = blockchain.openContract(await Alarm.fromAddress(alarmAddress));

        // Watchmaker send ring msg to oracle
        let ring: Ring = {
            $$type: 'Ring',
            queryID: 0n,
            alarmIndex: alarmIndex,
        };
        let ringResult = await oracle.send(
            watchmaker.getSender(),
            {
                value: toNano('10'),
            },
            ring
        );

        // Check that alarm contract send Chronoshift to oracle with remaining balance
        expect(ringResult.transactions).toHaveTransaction({
            from: alarmAddress,
            to: oracle.address,
            success: true,
        });
        // printTransactionFees(ringResult.transactions);
        await alarmContract.getGetRemainScale().catch((err) => {
            expect(err.message).toEqual('Trying to run get method on non-active contract');
        });
    });

    it('Ring Test: Should fail transaction if Chronoshift is not from alarm contract', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);

        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);

        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 10; // 10usdt

        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);

        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);

        // Watchmaker should send ring msg to oracle
        let alarmIndex = 0n;

        // Timekeeper send Chronoshift to oracle with remaining balance
        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');
        let chronoshift: Chronoshift = {
            $$type: 'Chronoshift',
            queryID: 0n,
            createdAt: 0n,
            alarmIndex: alarmIndex,
            watchmaker: watchmaker.address,
            baseAssetPrice: 4n,
            remainScale: 1n,
            remainBaseAssetScale: 1n,
            remainQuoteAssetScale: 1n,
            extraBaseAssetAmount: toBigInt(toUSDT(2.5)),
            extraQuoteAssetAmount: BigInt(quoteAssetToTransfer1),
        };
        let chronoshiftResult = await oracle.send(
            timekeeper.getSender(),
            {
                value: toNano('10'),
            },
            chronoshift
        );

        // Should fail because msg is not from alarm contract
        expect(chronoshiftResult.transactions).toHaveTransaction({
            from: timekeeper.address,
            to: oracle.address,
            success: false,
        });
    });

    it('Ring Test: Should update price if remain scale is not zero', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);

        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);

        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 3; // 1 ton = 3usdt

        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);

        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);

        // Watchmaker should send ring msg to oracle
        let alarmIndex = 0n;

        // wait for 100 seconds on the blockchain
        blockchain.now = blockchain.now!! + 100;

        // Watchmaker send ring msg to oracle
        let ring: Ring = {
            $$type: 'Ring',
            queryID: 0n,
            alarmIndex: alarmIndex,
        };
        await oracle.send(
            watchmaker.getSender(),
            {
                value: toNano('10'),
            },
            ring
        );

        // Check the latest price is updated
        let latestPrice = await oracle.getGetLatestBaseAssetPrice();
        expect(latestPrice).not.toEqual(0n);
    });

    it('Ring Test: Should not update price if remain scale is zero', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);

        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);

        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 4; // 10usdt

        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);

        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);

        // Watchmaker should send ring msg to oracle
        let alarmIndex = 0n;

        let alarmAddress = await oracle.getGetAlarmAddress(alarmIndex);
        let alarmContract = blockchain.openContract(await Alarm.fromAddress(alarmAddress));

        // Get the latest price
        let latestPrice = await oracle.getGetLatestBaseAssetPrice();

        // timekeeper send wind msg to oracle

        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');

        // timekeeper's jetton wallet address
        const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        await jettonMaster.getGetWalletAddress(timekeeper.address);
        // timekeeper's jetton wallet
        blockchain.openContract(await ExampleJettonWallet.fromAddress(oracleWalletAddress));
        await mintToken(jettonMaster, timekeeper);
        let alarmIndexBefore = 0n;
        let buyNum = 1;
        await windInJettonTransfer(timekeeper, oracle, alarmIndexBefore, buyNum, '5');

        // Check that remainScale of alarm0 is 0
        let remainScale = await alarmContract.getGetRemainScale();
        expect(remainScale).toEqual(0n);

        // wait for 100 seconds on the blockchain
        blockchain.now = blockchain.now!! + 100;

        // Watchmaker send ring msg to oracle
        let ring: Ring = {
            $$type: 'Ring',
            queryID: 0n,
            alarmIndex: alarmIndex,
        };
        await oracle.send(
            watchmaker.getSender(),
            {
                value: toNano('10'),
            },
            ring
        );

        // Check the latest price is not updated
        let latestPriceAfter = await oracle.getGetLatestBaseAssetPrice();
        expect(latestPriceAfter).toEqual(latestPrice);
    });

    it('Ring Test: Should not update price if the interval is smaller or equal than timePace', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);

        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);

        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 10; // 1

        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);

        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);

        // Watchmaker should send ring msg to oracle
        let alarmIndex = 0n;

        // Get the latest price
        let latestPrice = await oracle.getGetLatestBaseAssetPrice();

        // Watchmaker send ring msg to oracle
        let ring: Ring = {
            $$type: 'Ring',
            queryID: 0n,
            alarmIndex: alarmIndex,
        };
        await oracle.send(
            watchmaker.getSender(),
            {
                value: toNano('10'),
            },
            ring
        );

        // Check the latest price is not updated
        let latestPriceAfter = await oracle.getGetLatestBaseAssetPrice();
        expect(latestPriceAfter).toEqual(latestPrice);
    });

    it('Ring Test: Should return remaining funds back to Watchmaker (If remainQuoteAssetScale > 0)', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);

        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);

        let watchmakerWalletAddress = await jettonMaster.getGetWalletAddress(watchmaker.address);
        let watchmakerJettonWallet = blockchain.openContract(
            await ExampleJettonWallet.fromAddress(watchmakerWalletAddress)
        );
        // Get the balance of watchmaker's jetton wallet
        let jettonBalanceBefore = (await watchmakerJettonWallet.getGetWalletData()).balance;
        let balanceBefore = await watchmaker.getBalance();
        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 10; // 10usdt

        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);

        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);

        // Watchmaker should send ring msg to oracle
        let alarmIndex = 0n;

        // Wait for 100 seconds on the blockchain
        blockchain.now = blockchain.now!! + 100;

        // Watchmaker send ring msg to oracle
        let ring: Ring = {
            $$type: 'Ring',
            queryID: 0n,
            alarmIndex: alarmIndex,
        };
        let ringResult = await oracle.send(
            watchmaker.getSender(),
            {
                value: toNano('10'),
            },
            ring
        );
        let balanceAfter = await watchmaker.getBalance();

        // Get the balance of watchmaker's jetton wallet
        let jettonBalanceAfter = (await watchmakerJettonWallet.getGetWalletData()).balance;

        // Check that watchmaker's jetton wallet get the remaining funds
        let oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);

        expect(ringResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: oracleWalletAddress,
            success: true,
        });

        // Make sure that token is returned to watchmaker
        expect(Number(jettonBalanceAfter) / 2 ** 64).toBeCloseTo(
            Number(jettonBalanceBefore + BigInt(quoteAssetToTransfer1 * 10 ** 6)) / 2 ** 64,
            5
        );

        // Check that watchmaker get 1 ton that he ticked before
        expect(balanceBefore - balanceAfter).toBeGreaterThan(toNano('0.469')); // it cost watchmaker to 0.469 ton to tick a price
    });

    it('Ring Test: Should return remaining funds back to Watchmaker (If msg.remainBaseAssetScale > 0)', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);

        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);

        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 8; // 2usdt

        let balanceBefore = await watchmaker.getBalance();
        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);

        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);

        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');
        await mintToken(jettonMaster, timekeeper);
        let alarmIndex = 0n;
        let buyNum = 1;
        let timekeeperBalanceBefore = await timekeeper.getBalance();
        const { windResult } = await windInJettonTransfer(timekeeper, oracle, alarmIndex, buyNum, '5');

        // Watchmaker should send ring msg to oracle

        // Wait for 100 seconds on the blockchain
        blockchain.now = blockchain.now!! + 100;

        // Watchmaker send ring msg to oracle
        let ring: Ring = {
            $$type: 'Ring',
            queryID: 0n,
            alarmIndex: alarmIndex,
        };

        blockchain.now = blockchain.now!! + 100;
        await oracle.send(
            watchmaker.getSender(),
            {
                value: toNano('10'),
            },
            ring
        );
        let balanceAfter = await watchmaker.getBalance();

        // Check that watchmaker get 1 ton that he ticked before
        expect(balanceAfter - balanceBefore).toBeGreaterThan(toNano('1') - toNano('0.469')); // it won't be exactly 2 because of the transaction fee
        expect(await oracle.getGetMyBalance()).toBeGreaterThan(toNano('2')); // This 1.99 ton is timekeeper's baseAsset
        // Check that watchmaker didn't get the reward token, because he was winded by timekeeper
        let watchmakerRewardWallet = await oracle.getGetWalletAddress(watchmaker.address);
        let watchmakerRewardWalletContract = blockchain.openContract(
            await RewardJettonWallet.fromAddress(watchmakerRewardWallet)
        );
        await watchmakerRewardWalletContract.getGetWalletData().catch((err) => {
            expect(err.message).toEqual('Trying to run get method on non-active contract');
        });
    });

    it('Ring Test: Should reward watchmaker after ring', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        let oracleBalance = await oracle.getGetMyBalance();
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);

        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 3; // 1 ton = 3usdt

        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);

        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);

        // Watchmaker should send ring msg to oracle
        let alarmIndex = 0n;

        // wait for 100 seconds on the blockchain
        blockchain.now = blockchain.now!! + 100;

        // Watchmaker send ring msg to oracle
        let ring: Ring = {
            $$type: 'Ring',
            queryID: 0n,
            alarmIndex: alarmIndex,
        };

        await oracle.send(
            watchmaker.getSender(),
            {
                value: toNano('10'),
            },
            ring
        );

        // Check that watchmaker get the reward token
        let watchmakerRewardWallet = await oracle.getGetWalletAddress(watchmaker.address);
        let watchmakerRewardWalletContract = blockchain.openContract(
            await RewardJettonWallet.fromAddress(watchmakerRewardWallet)
        );
        let watchmakerRewardWalletData = await watchmakerRewardWalletContract.getGetWalletData();
        let watchmakerRewardBalance = watchmakerRewardWalletData.balance;
        expect(watchmakerRewardWalletData.balance).toEqual(60000000n);
        // watchmaker post price to oracle
        const quoteAssetToTransfer2 = 3; // 1 ton = 3usdt
        let tickResult = await tickInJettonTransfer(
            watchmaker,
            oracle,
            quoteAssetToTransfer2,
            1,
            blockchain.now!! + 1000,
            2,
            2n
        );
        let alarmIndex2 = 1n;

        // wait for 100 seconds on the blockchain
        blockchain.now = blockchain.now!! + 100;

        // Watchmaker send ring msg to oracle
        let ring2: Ring = {
            $$type: 'Ring',
            queryID: 0n,
            alarmIndex: alarmIndex2,
        };

        let ringResult = await oracle.send(
            watchmaker.getSender(),
            {
                value: toNano('10'),
            },
            ring2
        );
        watchmakerRewardWalletData = await watchmakerRewardWalletContract.getGetWalletData();
        let watchmakerRewardBalanceAfter = watchmakerRewardWalletData.balance;
        expect(watchmakerRewardBalanceAfter).toEqual(watchmakerRewardBalance + 1000000n);
        let oracleBalanceAfter = await oracle.getGetMyBalance();
        expect(oracleBalanceAfter - oracleBalance).toBeGreaterThan(0n); // Oracle's balance is sligjtly increased
    });

    it('Ring Test: Should timekeeper ring his alarm and get the reward', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        let oracleBalance = await oracle.getGetMyBalance();
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);

        // watchmaker post price to oracle
        const quoteAssetToTransfer1 = 8; // 8usdt
        const watchmakerWalletAddress = await jettonMaster.getGetWalletAddress(watchmaker.address);
        const watchmakerJettonContract = blockchain.openContract(
            ExampleJettonWallet.fromAddress(watchmakerWalletAddress)
        );
        let watchmakerBalanceBefore = (await watchmakerJettonContract.getGetWalletData()).balance;
        await tickInJettonTransfer(watchmaker, oracle, quoteAssetToTransfer1);

        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');
        await mintToken(jettonMaster, timekeeper);
        let alarmIndex = 0n;
        let buyNum = 1;
        let timekeeperBalanceBefore = await timekeeper.getBalance();
        await windInJettonTransfer(timekeeper, oracle, alarmIndex, buyNum, '5');

        // Watchmaker should send ring msg to oracle

        // Wait for 100 seconds on the blockchain
        blockchain.now = blockchain.now!! + 100;

        // Watchmaker send ring msg to oracle
        let ring: Ring = {
            $$type: 'Ring',
            queryID: 0n,
            alarmIndex: alarmIndex,
        };

        blockchain.now = blockchain.now!! + 100;
        await oracle.send(
            watchmaker.getSender(),
            {
                value: toNano('10'),
            },
            ring
        );
        alarmIndex = 1n;
        let ring2: Ring = {
            $$type: 'Ring',
            queryID: 0n,
            alarmIndex: alarmIndex,
        };
        await oracle.send(
            timekeeper.getSender(),
            {
                value: toNano('10'),
            },
            ring2
        );
        let oracleBalanceAfter = await oracle.getGetMyBalance();

        // Chekc that timekeepr pay 1 ton to by usdt and 0.48 ton for tx fee
        let timekeeperBalanceAfter = await timekeeper.getBalance();

        expect(timekeeperBalanceBefore - timekeeperBalanceAfter).toBeGreaterThan(toNano('1.48')); // 1 ton is selled to watchmaker, 0.48 ton is for tx fee
        // Check that watchmaker's 8 usdt is bought by timekeeper
        let watchmakerBalanceAfter = (await watchmakerJettonContract.getGetWalletData()).balance;
        expect(watchmakerBalanceBefore - watchmakerBalanceAfter).toEqual(8000000n); // 8 usdt is bought from timekeeper

        // Check that timekeeper get the reward token
        let timekeeperRewardWallet = await oracle.getGetWalletAddress(timekeeper.address);
        let timekeeperRewardWalletContract = blockchain.openContract(
            await RewardJettonWallet.fromAddress(timekeeperRewardWallet)
        );
        let timekeeperRewardWalletData = await timekeeperRewardWalletContract.getGetWalletData();
        let timekeeperRewardBalance = timekeeperRewardWalletData.balance;
        expect(timekeeperRewardBalance).toEqual(60000000n);
        expect(oracleBalanceAfter - oracleBalance).toBeGreaterThan(0n); // Oracle's balance is sligjtly increased
    });
});
