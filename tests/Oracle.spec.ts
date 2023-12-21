import { Alarm } from '../build/Oracle/tact_Alarm';
import { Blockchain, SandboxContract, TreasuryContract, printTransactionFees } from '@ton-community/sandbox';
import { Address, Cell, address, beginCell, toNano } from 'ton-core';
import { Chime, JettonTransfer, OracleV0, Reset, Tock } from '../wrappers/Oracle_OracleV0';
import { Ring, Mute, Chronoshift } from '../wrappers/Oracle_OracleV0';
import { ExampleJettonMaster } from '../wrappers/Jetton_ExampleJettonMaster';
import { ExampleJettonWallet } from './../build/Jetton/tact_ExampleJettonWallet';
import Decimal from 'decimal.js';
import { float, toToken } from './utils';
import '@ton-community/test-utils';

const QUOTEASSET_DECIMALS = 6;
const BASEASSET_DECIMALS = 9;

const toUSDT = (amount: number | string | Decimal) => toToken(amount, QUOTEASSET_DECIMALS);
const toTON = (amount: number | string | Decimal) => toToken(amount, BASEASSET_DECIMALS);
const toBigInt = (amount: number | string | Decimal) => BigInt(new Decimal(amount).floor().toString());

describe('Oracle', () => {
    let blockchain: Blockchain;
    let oracle: SandboxContract<OracleV0>;
    let owner: SandboxContract<TreasuryContract>;
    let watchmaker: SandboxContract<TreasuryContract>;
    let jettonMaster: SandboxContract<ExampleJettonMaster>;
    let zero_address: Address = new Address(0, Buffer.alloc(32));
    async function initializeOracle(oracle: SandboxContract<OracleV0>, owner: SandboxContract<TreasuryContract>) {
        const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        const oracleJettonContract = blockchain.openContract(
            await ExampleJettonWallet.fromAddress(oracleWalletAddress)
        );

        const initResult = await oracle.send(
            owner.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'Initialize',
                baseAssetWallet: zero_address,
                quoteAssetWallet: oracleWalletAddress,
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
     * @param watchmaker The caller of this function to trigger the tick msg
     * @param oracle The oracle contract
     * @param quoteAssetPerBaseAsset  The price of quoteAsset per baseAsset, e.g. 1 ton = 4 usdt, then rawQuoteAssetPerBaseAsset = 4
     * @param quoteAssetToTransfer The amount of quoteAsset to transfer, e.g. then rawQuoteAssetAmount = 10 for 10 usdt
     * @param expireAt The lifetime of this price, e.g. 1734022044
     * @param tonToTransfer The amount of ton to transfer, should bigger than forward_ton_amount
     */
    async function tickInJettonTransfer(
        watchmaker: SandboxContract<TreasuryContract>,
        oracle: SandboxContract<OracleV0>,
        quoteAssetPerBaseAsset: number,
        quoteAssetToTransfer: number,
        expireAt: number,
        tonToTransfer: number
    ) {
        const baseAssetPrice = float(toUSDT(quoteAssetPerBaseAsset));
        const quoteAssetTransferred = toUSDT(quoteAssetToTransfer);
        const forwardTonAmount = toTON(float(quoteAssetTransferred).div(baseAssetPrice)).add(toTON(0.055));

        const forwardInfo: Cell = beginCell()
            .storeUint(0, 8)
            .storeUint(expireAt, 256)
            .storeUint(baseAssetPrice.toNumber(), 256)
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
            { value: toNano(tonToTransfer) },
            jettonTransfer
        );
        //printTransactionFees(transfterResult.transactions);

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
        expect(alarmIndex).toEqual(1n);

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

    async function windInJettonTransfer(
        timekeeper: SandboxContract<TreasuryContract>,
        oracle: SandboxContract<OracleV0>,
        alarmIndex: number,
        buyNum: number,
        side: number,
        newBaseAssetPrice: number,
        quoteAssetToTransfer: number,
        transferValue: number
    ) {
        let op = 1; // 1 means wind
        const baseAssetPrice = float(toUSDT(newBaseAssetPrice));
        const quoteAssetTransferred = toUSDT(quoteAssetToTransfer);
        const forwardTonAmount = toTON(float(quoteAssetTransferred).div(baseAssetPrice)).add(toTON(0.055));
        const forwardInfo: Cell = beginCell()
            .storeUint(op, 8)
            .storeUint(alarmIndex, 256)
            .storeUint(buyNum, 32)
            .storeUint(side, 1)
            .storeUint(newBaseAssetPrice, 256)
            .endCell();
        const jettonTransfer: JettonTransfer = {
            $$type: 'JettonTransfer',
            query_id: 0n,
            amount: toBigInt(quoteAssetTransferred),
            destination: oracle.address,
            response_destination: timekeeper.address,
            custom_payload: null,
            forward_ton_amount: toBigInt(forwardTonAmount),
            forward_payload: beginCell().storeRef(forwardInfo).endCell(),
        };

        // watchmaker's jetton wallet address
        const timekeeperWalletAddress = await jettonMaster.getGetWalletAddress(timekeeper.address);
        // watchmaker's jetton wallet
        const timekeeperJettonContract = blockchain.openContract(
            await ExampleJettonWallet.fromAddress(timekeeperWalletAddress)
        );
        const windResult = await timekeeperJettonContract.send(
            timekeeper.getSender(),
            {
                value: toNano(transferValue),
            },
            jettonTransfer
        );

        return windResult;
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
                value: toNano('5'),
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

    it('should deploy', async () => {
        // the check is done inside beforeEach
        // blockchain and oracle are ready to use
    });

    it('should watchmaker sends tick msg to oracle by functions', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const quoteAssetPerBaseAsset = 4; // 4 usdt for 1 ton
        const quoteAssetToTransfer = 10; // expected to transfer 10 usdt
        const expireAt = blockchain.now! + 1000; // the price will be expired at 1000 logic time
        const tonToTransfer = 10; // expected to transfer 10 ton
        const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        const jettonTransferResult = await tickInJettonTransfer(
            watchmaker,
            oracle,
            quoteAssetPerBaseAsset,
            quoteAssetToTransfer,
            expireAt,
            tonToTransfer
        );
        expect(jettonTransferResult.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: oracle.address,
            success: true,
        });
        // Check that alarm count is 1
        let alarmIndex = await oracle.getTotalAmount();
        expect(alarmIndex).toEqual(1n);
    });

    it('Should fail if message is not from oracle', async () => {
        // Initialize oracle
        const initResult = await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        const mintyResult = await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const baseAssetPriceAmount = 4; // 1 ton = 4usdt
        const baseAssetAmount = 10; // 10usdt
        const expireAt = blockchain.now!! + 1000;
        const tonToTransfer = 10;
        const transfterResult = await tickInJettonTransfer(
            watchmaker,
            oracle,
            baseAssetPriceAmount,
            baseAssetAmount,
            expireAt,
            tonToTransfer
        );

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

    it('Should return funds if remaining ton is sufficient to pay the gas', async () => {
        // TODO: the code in oracle for now is not support "Invalid jetton token received" and "Amount is lower than the lowerbound (theshold for baseAsset + gas)"
        // Initialize oracle
        const initResult = await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        const mintyResult = await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt
        const expireAt = blockchain.now!! + 1000;
        const tonToTransfer = 10;
        const transfterResult = await tickInJettonTransfer(
            watchmaker,
            oracle,
            baseAssetPriceAmount,
            baseAssetAmount,
            expireAt,
            tonToTransfer
        );
        //printTransactionFees(transfterResult.transactions);
    });

    it('Should timekeeper send wind msg to oracle', async () => {
        // Initialize oracle
        const initResult = await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        const mintyResult = await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt
        const expireAt = blockchain.now!! + 1000;
        const tonToTransfer = 10;
        const transfterResult = await tickInJettonTransfer(
            watchmaker,
            oracle,
            baseAssetPriceAmount,
            baseAssetAmount,
            expireAt,
            tonToTransfer
        );
        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);
        // Timekeeper send wind msg to oracle
        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');
        const mintTimekeeperResult = await mintToken(jettonMaster, timekeeper);
        let alarmIndex = 0;
        let buyNum = 1;
        let side = 0;
        //const windResult = await windInJettonTransfer(timekeeper, oracle, alarmIndex, buyNum, side, transferValue);
        let op = 1; // 1 means wind
        let newBaseAssetPrice = 4;
        let quoteAssetToTransfer = 20;
        let tonTransfer = 10;
        const windResult = await windInJettonTransfer(
            timekeeper,
            oracle,
            alarmIndex,
            buyNum,
            side,
            newBaseAssetPrice,
            quoteAssetToTransfer,
            tonTransfer
        );

        // watchmaker's jetton wallet address
        const timekeeperWalletAddress = await jettonMaster.getGetWalletAddress(timekeeper.address);
        // watchmaker's jetton wallet
        const timekeeperJettonContract = blockchain.openContract(
            ExampleJettonWallet.fromAddress(timekeeperWalletAddress)
        );

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

    it('Should return funds if side or alarmIndex is incorrect', async () => {
        // Initialize oracle
        const initResult = await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        const mintyResult = await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt
        const expireAt = blockchain.now!! + 1000;
        const tonToTransfer = 10;
        const transfterResult = await tickInJettonTransfer(
            watchmaker,
            oracle,
            baseAssetPriceAmount,
            baseAssetAmount,
            expireAt,
            tonToTransfer
        );
        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);
        // Timekeeper send wind msg to oracle
        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');

        // timekeeper's jetton wallet address
        const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        const timekeeperWalletAddress = await jettonMaster.getGetWalletAddress(timekeeper.address);
        // timekeeper's jetton wallet
        const oracleJettonContract = blockchain.openContract(
            await ExampleJettonWallet.fromAddress(oracleWalletAddress)
        );
        const mintTimekeeperResult = await mintToken(jettonMaster, timekeeper);
        let wrongAlarmIndex = 10;
        let buyNum = 1;
        let side = 0;
        let newBaseAssetPrice = 4;
        let quoteAssetToTransfer = 20;
        let windResult = await windInJettonTransfer(
            timekeeper,
            oracle,
            wrongAlarmIndex,
            buyNum,
            side,
            newBaseAssetPrice,
            quoteAssetToTransfer,
            tonToTransfer
        );

        // Fail because alarmIndex is incorrect
        expect(windResult.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: oracle.address,
            success: false,
        });

        // It's no way to assign side to a wrong value, so we don't test it here
        // Becuase its size is 1 bit, so it's no way to assign a wrong value(others value than 0 and 1) to it
    });

    it('Should fail transaction if Reset message is not from Oracle', async () => {
        // Initialize oracle
        const initResult = await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        const mintyResult = await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt
        const expireAt = blockchain.now!! + 1000;
        const tonToTransfer = 10;
        const transfterResult = await tickInJettonTransfer(
            watchmaker,
            oracle,
            baseAssetPriceAmount,
            baseAssetAmount,
            expireAt,
            tonToTransfer
        );

        const resetMsg: Reset = {
            $$type: 'Reset',
            sender: owner.address,
            buyNum: 1n, // The number of scales to buy
            side: 1n, // 0 for baseAsset, 1 for quoteAsset
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

    it('Should fail transaction if Chime message not came from Alarm contract', async () => {
        // Initialize oracle
        const initResult = await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        const mintyResult = await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt
        const expireAt = blockchain.now!! + 1000;
        const tonToTransfer = 10;
        const transfterResult = await tickInJettonTransfer(
            watchmaker,
            oracle,
            baseAssetPriceAmount,
            baseAssetAmount,
            expireAt,
            tonToTransfer
        );

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
        };
        let AlarmAddress = await oracle.getGetAlarmAddress(0n);
        const alarm0 = blockchain.openContract(await Alarm.fromAddress(AlarmAddress));
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

    it('Should update price according to the formula in the Chime msg', async () => {
        // Initialize oracle
        await initializeOracle(oracle, owner);

        // Mint tokens to watchmaker
        await mintToken(jettonMaster, watchmaker);

        // watchmaker send tick msg to oracle
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt
        const expireAt = blockchain.now!! + 1000;
        const tonToTransfer = 10;
        await tickInJettonTransfer(watchmaker, oracle, baseAssetPriceAmount, baseAssetAmount, expireAt, tonToTransfer);
        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);

        // Timekeeper send wind msg to oracle
        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');
        // timekeeper's jetton wallet address
        const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        await mintToken(jettonMaster, timekeeper);

        let alarmIndex = 0;
        let buyNum = 1;
        let side = 0;
        let newBaseAssetPrice = 5;
        let quoteAssetToTransfer = 20;
        let windResult = await windInJettonTransfer(
            timekeeper,
            oracle,
            alarmIndex,
            buyNum,
            side,
            newBaseAssetPrice,
            quoteAssetToTransfer,
            tonToTransfer
        );

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

        blockchain.now = Math.floor(Date.now() / 1000) + 61; // Wating for 61 seconds to pass the verification period

        let alarmIndex2 = 1;
        let buyNum2 = 1;
        let side2 = 0;
        let newBaseAssetPrice2 = 4;
        let quoteAssetToTransfer2 = 20;
        let windResult2 = await windInJettonTransfer(
            timekeeper2,
            oracle,
            alarmIndex2,
            buyNum2,
            side2,
            newBaseAssetPrice2,
            quoteAssetToTransfer2,
            tonToTransfer
        );
        let timekeeperWalletAddress2 = await jettonMaster.getGetWalletAddress(timekeeper2.address);

        // Check that after timekeeper wind and he didn't buy all assets, the LatestBaseAssetPrice will be update to the price that miner set
        let latestPrice = await oracle.getGetLatestBaseAssetPrice();
        expect(latestPrice).toEqual(BigInt(newBaseAssetPrice));

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

        // Check that Alarm1 baseAssetPrice is new Price
        let alarmAddress2 = await oracle.getGetAlarmAddress(2n);
        let alarm2 = blockchain.openContract(Alarm.fromAddress(alarmAddress2));
        let alarmNewPrice = await alarm2.getGetBaseAssetPrice();
        expect(alarmNewPrice).toEqual(BigInt(newBaseAssetPrice2));

        // Check that return the remaining funds back to the Timekeeper2
        expect(windResult2.transactions).toHaveTransaction({
            from: alarm1Address2,
            to: timekeeper2.address,
            success: true,
        });

        // Check that Oracle send Jetton Transfer message to refund jetton to timekeeper2
        expect(windResult2.transactions).toHaveTransaction({
            from: oracle.address,
            to: oracleWalletAddress,
            success: true,
        });

        // Check that oracle Wallet send JettonInternalTransfer msg to timekeeper2's jetton wallet
        expect(windResult2.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: timekeeperWalletAddress2,
            success: true,
        });
    });

    it('Ring Test: Should fail if alarm index does not exists', async () => {
        // Initialize oracle
        const initResult = await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        const mintyResult = await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt
        const expireAt = blockchain.now!! + 1000;
        const tonToTransfer = 10;
        const transfterResult = await tickInJettonTransfer(
            watchmaker,
            oracle,
            baseAssetPriceAmount,
            baseAssetAmount,
            expireAt,
            tonToTransfer
        );
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
        const initResult = await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        const mintyResult = await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt
        const expireAt = blockchain.now!! + 1000;
        const tonToTransfer = 10;
        const transfterResult = await tickInJettonTransfer(
            watchmaker,
            oracle,
            baseAssetPriceAmount,
            baseAssetAmount,
            expireAt,
            tonToTransfer
        );
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
        let alarmContract = blockchain.openContract(await Alarm.fromAddress(alarmAddress));
        expect(ringResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: alarmAddress,
            success: true,
        });
    });

    it('Ring Test: Should failed if Mute message is not from oracle', async () => {
        // Initialize oracle
        const initResult = await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        const mintyResult = await mintToken(jettonMaster, watchmaker);

        // watchmaker post price to oracle
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt

        const expireAt = blockchain.now!! + 1000;
        const tonToTransfer = 10;

        const transfterResult = await tickInJettonTransfer(
            watchmaker,
            oracle,
            baseAssetPriceAmount,
            baseAssetAmount,
            expireAt,
            tonToTransfer
        );

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
        const initResult = await initializeOracle(oracle, owner);

        // Mint tokens to watchmaker
        const mintyResult = await mintToken(jettonMaster, watchmaker);

        // watchmaker post price to oracle
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt

        const expireAt = blockchain.now!! + 1000;
        const tonToTransfer = 10;

        const transfterResult = await tickInJettonTransfer(
            watchmaker,
            oracle,
            baseAssetPriceAmount,
            baseAssetAmount,
            expireAt,
            tonToTransfer
        );

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
        let remainScale = await alarmContract.getGetRemainScale().catch((err) => {
            console.log(err);
        });
    });

    it('Ring Test: Should fail transaction if Chronoshift is not from alarm contract', async () => {
        // Initialize oracle
        const initResult = await initializeOracle(oracle, owner);

        // Mint tokens to watchmaker
        const mintyResult = await mintToken(jettonMaster, watchmaker);

        // watchmaker post price to oracle
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt

        const expireAt = blockchain.now!! + 1000;
        const tonToTransfer = 10;

        const transfterResult = await tickInJettonTransfer(
            watchmaker,
            oracle,
            baseAssetPriceAmount,
            baseAssetAmount,
            expireAt,
            tonToTransfer
        );

        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);

        // Watchmaker should send ring msg to oracle
        let alarmIndex = 0n;

        let alarmAddress = await oracle.getGetAlarmAddress(alarmIndex);
        let alarmContract = blockchain.openContract(await Alarm.fromAddress(alarmAddress));

        // Timekeeper send Chronoshift to oracle with remaining balance
        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');
        let chronoshift: Chronoshift = {
            $$type: 'Chronoshift',
            queryID: 0n,
            createdAt: 0n,
            alarmIndex: alarmIndex,
            watchmaker: watchmaker.address,
            baseAssetPrice: BigInt(baseAssetPriceAmount),
            remainScale: 1n,
            remainBaseAssetScale: 1n,
            remainQuoteAssetScale: 1n,
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
        const initResult = await initializeOracle(oracle, owner);

        // Mint tokens to watchmaker
        const mintyResult = await mintToken(jettonMaster, watchmaker);

        // watchmaker post price to oracle
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt

        const expireAt = blockchain.now!! + 1000;
        const tonToTransfer = 10;

        const transfterResult = await tickInJettonTransfer(
            watchmaker,
            oracle,
            baseAssetPriceAmount,
            baseAssetAmount,
            expireAt,
            tonToTransfer
        );

        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);

        // Watchmaker should send ring msg to oracle
        let alarmIndex = 0n;

        let alarmAddress = await oracle.getGetAlarmAddress(alarmIndex);
        let alarmContract = blockchain.openContract(await Alarm.fromAddress(alarmAddress));

        // TODO: wait for 100 seconds on the blockchain
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

        // Check the latest price is updated
        let latestPrice = await oracle.getGetLatestBaseAssetPrice();
        console.log('latestPrice: ', latestPrice);
        expect(latestPrice).not.toEqual(0n);
    });

    it('Ring Test: Should not update price if remain scale is zero', async () => {
        // Initialize oracle
        const initResult = await initializeOracle(oracle, owner);

        // Mint tokens to watchmaker
        const mintyResult = await mintToken(jettonMaster, watchmaker);

        // watchmaker post price to oracle
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt

        const expireAt = blockchain.now!! + 1000;
        const tonToTransfer = 10;

        const transfterResult = await tickInJettonTransfer(
            watchmaker,
            oracle,
            baseAssetPriceAmount,
            baseAssetAmount,
            expireAt,
            tonToTransfer
        );

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
        const timekeeperWalletAddress = await jettonMaster.getGetWalletAddress(timekeeper.address);
        // timekeeper's jetton wallet
        const oracleJettonContract = blockchain.openContract(
            await ExampleJettonWallet.fromAddress(oracleWalletAddress)
        );
        const mintTimekeeperResult = await mintToken(jettonMaster, timekeeper);
        let alarmIndexBefore = 0;
        let buyNum = 1;
        let side = 0;
        let newBaseAssetPrice = 4;
        let quoteAssetToTransfer = 20;
        let windResult = await windInJettonTransfer(
            timekeeper,
            oracle,
            alarmIndexBefore,
            buyNum,
            side,
            newBaseAssetPrice,
            quoteAssetToTransfer,
            tonToTransfer
        );
        // let windResult = await windInJettonTransfer(timekeeper, oracle, alarmIndexBefore, buyNum, side, tonToTransfer);
        // printTransactionFees(windResult.transactions);

        // Check that remainScale of alarm0 is 0
        let remainScale = await alarmContract.getGetRemainScale();
        expect(remainScale).toEqual(0n);

        // TODO: wait for 100 seconds on the blockchain
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

        // Check the latest price is not updated
        let latestPriceAfter = await oracle.getGetLatestBaseAssetPrice();
        // console.log('latestPrice: ', latestPrice);
        // console.log('latestPriceAfter: ', latestPriceAfter);
        expect(latestPriceAfter).toEqual(latestPrice);
    });

    it('Ring Test: Should not update price if the interval is smaller or equal than timePace', async () => {
        // Initialize oracle
        const initResult = await initializeOracle(oracle, owner);

        // Mint tokens to watchmaker
        const mintyResult = await mintToken(jettonMaster, watchmaker);

        // watchmaker post price to oracle
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt

        const expireAt = blockchain.now!! + 100;
        const tonToTransfer = 10;

        const transfterResult = await tickInJettonTransfer(
            watchmaker,
            oracle,
            baseAssetPriceAmount,
            baseAssetAmount,
            expireAt,
            tonToTransfer
        );

        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);

        // Watchmaker should send ring msg to oracle
        let alarmIndex = 0n;

        let alarmAddress = await oracle.getGetAlarmAddress(alarmIndex);
        let alarmContract = blockchain.openContract(await Alarm.fromAddress(alarmAddress));

        // Get the latest price
        let latestPrice = await oracle.getGetLatestBaseAssetPrice();

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

        // Check the latest price is not updated
        let latestPriceAfter = await oracle.getGetLatestBaseAssetPrice();
        expect(latestPriceAfter).toEqual(latestPrice);
    });

    it('Ring Test: Should return remaining funds back to Watchmaker', async () => {
        // Initialize oracle
        const initResult = await initializeOracle(oracle, owner);

        // Mint tokens to watchmaker
        const mintyResult = await mintToken(jettonMaster, watchmaker);

        // watchmaker post price to oracle
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt

        const expireAt = blockchain.now!! + 1000;
        const tonToTransfer = 10;

        const transfterResult = await tickInJettonTransfer(
            watchmaker,
            oracle,
            baseAssetPriceAmount,
            baseAssetAmount,
            expireAt,
            tonToTransfer
        );

        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);

        // Watchmaker should send ring msg to oracle
        let alarmIndex = 0n;

        let alarmAddress = await oracle.getGetAlarmAddress(alarmIndex);
        let alarmContract = blockchain.openContract(await Alarm.fromAddress(alarmAddress));

        // TODO: Wait for 100 seconds on the blockchain
        blockchain.now = blockchain.now!! + 100;

        let watchmakerWalletAddress = await jettonMaster.getGetWalletAddress(watchmaker.address);
        let watchmakerJettonWallet = blockchain.openContract(
            await ExampleJettonWallet.fromAddress(watchmakerWalletAddress)
        );
        // Get the balance of watchmaker's jetton wallet
        let balanceBefore = (await watchmakerJettonWallet.getGetWalletData()).balance;

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

        printTransactionFees(ringResult.transactions);

        // Get the balance of watchmaker's jetton wallet
        let balanceAfter = (await watchmakerJettonWallet.getGetWalletData()).balance;

        // Check that watchmaker's jetton wallet get the remaining funds
        let oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        expect(ringResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: oracleWalletAddress,
            success: true,
        });

        expect(balanceAfter).toEqual(balanceBefore + BigInt(baseAssetAmount * 10 ** 6));
    });
});
