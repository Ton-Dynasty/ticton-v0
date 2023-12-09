import { Alarm } from './../build/Oracle/tact_Alarm';
import { Blockchain, SandboxContract, TreasuryContract, printTransactionFees } from '@ton-community/sandbox';
import { Address, Cell, address, beginCell, toNano } from 'ton-core';
import { Chime, JettonTransfer, OracleV0, Reset, Tock } from '../wrappers/Oracle_OracleV0';
import { ExampleJettonMaster } from '../wrappers/Jetton_ExampleJettonMaster';
import { ExampleJettonWallet } from './../build/Jetton/tact_ExampleJettonWallet';
import '@ton-community/test-utils';
import { time } from 'console';

describe('Oracle', () => {
    let blockchain: Blockchain;
    let oracle: SandboxContract<OracleV0>;
    let owner: SandboxContract<TreasuryContract>;
    let watchmaker: SandboxContract<TreasuryContract>;
    let jettonMaster: SandboxContract<ExampleJettonMaster>;
    let zero_address: Address = new Address(0, Buffer.alloc(32));
    const DECIMAL = 6n

    function toTic(input: number): bigint {
        const basePrice = input * 10 ** Number(DECIMAL);
        return BigInt(basePrice * 2 ** 68);
    }

    async function initializeOracle(oracle: SandboxContract<OracleV0>, owner: SandboxContract<TreasuryContract>){
        const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        const oracleJettonContract = blockchain.openContract(await ExampleJettonWallet.fromAddress(oracleWalletAddress));
    
        const initResult = await oracle.send(
            owner.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'Initialize',
                baseAssetWallet: zero_address,
                quoteAssetWallet: oracleWalletAddress
            }
        );
    
        return initResult ;
    }

    async function mintToken(jettonMaster: SandboxContract<ExampleJettonMaster>, watchmaker: SandboxContract<TreasuryContract>) {
        return await jettonMaster.send(
            watchmaker.getSender(),
            { value: toNano('1') },
            'Mint:1'
        );
    }
    
    async function tickInJettonTransfer(watchmaker: SandboxContract<TreasuryContract>, oracle: SandboxContract<OracleV0>, baseAssetPriceAmount: number, baseAssetAmount: number, expireAt: number, scale:number, transferValue: number) {
        const baseAssetPrice = toTic(baseAssetPriceAmount);
        const forwardTonAmount = toNano(toTic(baseAssetAmount) / baseAssetPrice) + toNano(0.5);
    
        const forwardInfo: Cell = beginCell()
            .storeUint(0, 8)
            .storeUint(expireAt, 256)
            .storeUint(baseAssetPrice, 256)
            .storeUint(scale, 32)
            .endCell();
    
        const jettonTransfer: JettonTransfer = {
            $$type: 'JettonTransfer',
            query_id: 0n,
            amount: BigInt(baseAssetAmount) * 10n ** DECIMAL,
            destination: oracle.address,
            response_destination: watchmaker.address,
            custom_payload: null,
            forward_ton_amount: forwardTonAmount,
            forward_payload: beginCell().storeRef(forwardInfo).endCell(),
        };
    
        const watchmakerWalletAddress = await jettonMaster.getGetWalletAddress(watchmaker.address);
        const watchmakerJettonContract = blockchain.openContract(await ExampleJettonWallet.fromAddress(watchmakerWalletAddress));
    
        return await watchmakerJettonContract.send(
            watchmaker.getSender(),
            { value: toNano(transferValue) },
            jettonTransfer
        );
    }

    async function windInJettonTransfer(timekeeper: SandboxContract<TreasuryContract>, oracle: SandboxContract<OracleV0>,alarmIndex: number,buyNum:number,side: number, transferValue: number) {
        let op = 1; // 1 means wind
        const forwardInfo: Cell = beginCell().storeUint(op,8).storeUint(alarmIndex,256).storeUint(buyNum,32).storeUint(side,1).endCell();
        const jettonTransfer: JettonTransfer = {
            $$type: 'JettonTransfer',
            query_id: 0n,
            amount: 1000000n,
            destination: oracle.address,
            response_destination: timekeeper.address,
            custom_payload: null,
            forward_ton_amount: toNano("5"),
            forward_payload: beginCell().storeRef(forwardInfo).endCell(),
        };

        // watchmaker's jetton wallet address
        const timekeeperWalletAddress = await jettonMaster.getGetWalletAddress(timekeeper.address);
        // watchmaker's jetton wallet
        const timekeeperJettonContract = blockchain.openContract(await ExampleJettonWallet.fromAddress(timekeeperWalletAddress));
        return await timekeeperJettonContract.send(
            timekeeper.getSender(),
            {
                value: toNano(transferValue),
            },
            jettonTransfer
        );
    }
    
    

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        watchmaker = await blockchain.treasury('watchmaker');
        const jetton_content: Cell = beginCell().endCell();
        jettonMaster = blockchain.openContract(await ExampleJettonMaster.fromInit(owner.address, jetton_content));

        oracle = blockchain.openContract(await OracleV0.fromInit(zero_address, jettonMaster.address))

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
    });

    it('should deploy', async () => {
        // the check is done inside beforeEach
        // blockchain and oracle are ready to use
    });

    it('should watchmaker sends tick msg to oralce', async () => {
        // Initialize oracle
        // oracle's jetton wallet address
        const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        // oracle's jetton wallet
        const oracleJettonContract = blockchain.openContract(await ExampleJettonWallet.fromAddress(oracleWalletAddress));
        const initResult = await oracle.send(
            owner.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Initialize',
                baseAssetWallet: zero_address,
                quoteAssetWallet: oracleWalletAddress
            }
        );

        // Check that Init was successful
        expect(initResult.transactions).toHaveTransaction({
            from: owner.address,
            to: oracle.address,
            success: true,
        });

        // Mint tokens to watchmaker
        const mintyResult = await jettonMaster.send(
            watchmaker.getSender(),
            {
                value: toNano('1'),
            },
            'Mint:1'
        );
        // watchmaker's jetton wallet address
        const watchmakerWalletAddress = await jettonMaster.getGetWalletAddress(watchmaker.address);
        // watchmaker's jetton wallet
        const watchmakerJettonContract = blockchain.openContract(await ExampleJettonWallet.fromAddress(watchmakerWalletAddress));


        // watchmaker transfer 1 ton and 10 usdt to oracle
        let baseAssetPriceAmount = 2.5;
        let baseAssetPrice = toTic(baseAssetPriceAmount);//Number(2.5 * 1000000) << 68;
        let baseAssetAmount = 10n * 1000000n;
        let forward_ton_amount = toNano(toTic(10)/baseAssetPrice) + toNano(1);
        let expireAt = 1000;
        let forwardInfo: Cell = beginCell().storeUint(0,8).storeUint(expireAt,256).storeUint(baseAssetPrice,256).storeUint(1,32).endCell();
        const jettonTransfer: JettonTransfer = {
            $$type: 'JettonTransfer',
            query_id: 0n,
            amount: baseAssetAmount,
            destination: oracle.address,
            response_destination: watchmaker.address,
            custom_payload: null,
            forward_ton_amount: forward_ton_amount,
            forward_payload: beginCell().storeRef(forwardInfo).endCell(),
        };
        const transfterResult = await watchmakerJettonContract.send(
            watchmaker.getSender(),
            {
                value: toNano('10'),
            },
            jettonTransfer
        );

        // Check that watchmaker send JettonTransfer msg to her jetton wallet
        expect(transfterResult.transactions).toHaveTransaction({
            from: watchmaker.address,
            to: watchmakerWalletAddress,
            success: true,
        });

        // Check that watchmaker's jetton wallet send JettonInternalTransfer msg to Bob's jetton wallet
        expect(transfterResult.transactions).toHaveTransaction({
            from: watchmakerWalletAddress,
            to: oracleWalletAddress,
            success: true,
        });

        // Check that oracle's jetton wallet send JettonTransferNotification msg to oracle
        expect(transfterResult.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: oracle.address,
            success: true,
        });
        
        let AlarmAddress = await oracle.getGetAlarmAddress(0n);
        // Check that oracle build alarm successfully
        expect(transfterResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: AlarmAddress,
            success: true,
        });

        // Check that alarm count is 1
        let alarmIndex = await oracle.getTotalAmount();
        expect(alarmIndex).toEqual(1n);

        // Check that alarm send build alarm msg to watchmaker
        expect(transfterResult.transactions).toHaveTransaction({
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

        // Check that baseAssetPrice is 3
        let price = await alarm0.getGetBaseAssetPrice();
        expect(price).toEqual(baseAssetPrice);

        //printTransactionFees(transfterResult.transactions);

    });

    it('should watchmaker sends tick msg to oralce by functions', async () => {
        // Initialize oracle
        const initResult = await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        const mintyResult = await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt
        const expireAt = 1000;
        const transferValue = 10;
        const scale = 1;
        const transfterResult = await tickInJettonTransfer(watchmaker, oracle, baseAssetPriceAmount, baseAssetAmount, expireAt, scale, transferValue);
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
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt
        const expireAt = 1000;
        const transferValue = 10;
        const scale = 1;
        const transfterResult = await tickInJettonTransfer(watchmaker, oracle, baseAssetPriceAmount, baseAssetAmount, expireAt, scale, transferValue);


        let AlarmAddress = await oracle.getGetAlarmAddress(0n);
        const tockMsg: Tock = {
            $$type: 'Tock',
            scale: 1n,
            createdAt: 0n,
            watchmaker: watchmaker.address,
            baseAssetPrice: toTic(3),
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
        // TODO: the code in orale for now is not support "Invalid jetton token received" and "Amount is lower than the lowerbound (theshold for baseAsset + gas)"
        // Initialize oracle
        const initResult = await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        const mintyResult = await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt
        const expireAt = 1000;
        const transferValue = 10;
        const scale = 0;
        const transfterResult = await tickInJettonTransfer(watchmaker, oracle, baseAssetPriceAmount, baseAssetAmount, expireAt,scale, transferValue);
        //printTransactionFees(transfterResult.transactions);
    });


    it('Should timekeeper send wind msg to orale', async () => {
        // Initialize oracle
        const initResult = await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        const mintyResult = await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt
        const expireAt = 1000;
        const transferValue = 10;
        const scale = 1;
        const transfterResult = await tickInJettonTransfer(watchmaker, oracle, baseAssetPriceAmount, baseAssetAmount, expireAt,scale, transferValue);
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
        const forwardInfo: Cell = beginCell().storeUint(op,8).storeUint(alarmIndex,256).storeUint(buyNum,32).storeUint(side,32).endCell();
        const jettonTransfer: JettonTransfer = {
            $$type: 'JettonTransfer',
            query_id: 0n,
            amount: 1000000n,
            destination: oracle.address,
            response_destination: timekeeper.address,
            custom_payload: null,
            forward_ton_amount: toNano("10"),
            forward_payload: beginCell().storeRef(forwardInfo).endCell(),
        };

        // watchmaker's jetton wallet address
        const timekeeperWalletAddress = await jettonMaster.getGetWalletAddress(timekeeper.address);
        // watchmaker's jetton wallet
        const timekeeperJettonContract = blockchain.openContract(await ExampleJettonWallet.fromAddress(timekeeperWalletAddress));
        const windResult = await timekeeperJettonContract.send(
            timekeeper.getSender(),
            {
                value: toNano('10'),
            },
            jettonTransfer
        );
        //printTransactionFees(windResult.transactions);

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
        let alarm0 = blockchain.openContract(await Alarm.fromAddress(AlarmAddress));
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
            const expireAt = 1000;
            const transferValue = 10;
            const scale = 1;
            const transfterResult = await tickInJettonTransfer(watchmaker, oracle, baseAssetPriceAmount, baseAssetAmount, expireAt,scale, transferValue);
            // Check that alarm count is 1
            let alarmIndexAfter = await oracle.getTotalAmount();
            expect(alarmIndexAfter).toEqual(1n);
            // Timekeeper send wind msg to oracle
            let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');

            // timekeeper's jetton wallet address
            const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
            const timekeeperWalletAddress = await jettonMaster.getGetWalletAddress(timekeeper.address);
            // timekeeper's jetton wallet
            const oracleJettonContract = blockchain.openContract(await ExampleJettonWallet.fromAddress(oracleWalletAddress));
            const mintTimekeeperResult = await mintToken(jettonMaster, timekeeper);
            let wrongAlarmIndex = 10;
            let buyNum = 1;
            let side = 0;
            let windResult = await windInJettonTransfer(timekeeper, oracle, wrongAlarmIndex, buyNum, side, transferValue);

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
        const expireAt = 1000;
        const transferValue = 10;
        const scale = 1;
        const transfterResult = await tickInJettonTransfer(watchmaker, oracle, baseAssetPriceAmount, baseAssetAmount, expireAt,scale, transferValue);

        const resetMsg: Reset = {
            $$type: 'Reset',
            sender: owner.address,
            buyNum: 1n, // The number of scales to buy
            side: 1n, // 0 for baseAsset, 1 for quoteAsset
            quoteAssetAmount: 1n // The amount of quoteAsset oracle received
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
        const expireAt = 1000;
        const transferValue = 10;
        const scale = 1;
        const transfterResult = await tickInJettonTransfer(watchmaker, oracle, baseAssetPriceAmount, baseAssetAmount, expireAt,scale, transferValue);

        const resetMsg: Chime = {
            $$type: 'Chime',
            alarmIndex: 0n,
            timeKeeper: owner.address,
            createdAt: 110n,
            baseAssetPrice: 1n,
            remainScale: 1n,
            newScale: 1n,
            refundBaseAssetAmount: 1n,
            refundQuoteAssetAmount: 1n
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
        const initResult = await initializeOracle(oracle, owner);
        // Mint tokens to watchmaker
        const mintyResult = await mintToken(jettonMaster, watchmaker);
        // watchmaker post price to oracle
        const baseAssetPriceAmount = 3; // 1 ton = 3usdt
        const baseAssetAmount = 10; // 10usdt
        const expireAt = 1000;
        const transferValue = 10;
        const scale = 1;
        const transfterResult = await tickInJettonTransfer(watchmaker, oracle, baseAssetPriceAmount, baseAssetAmount, expireAt,scale, transferValue);
        // Check that alarm count is 1
        let alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(1n);
        // Timekeeper send wind msg to oracle
        let timekeeper: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper');

        // timekeeper's jetton wallet address
        const oracleWalletAddress = await jettonMaster.getGetWalletAddress(oracle.address);
        const timekeeperWalletAddress = await jettonMaster.getGetWalletAddress(timekeeper.address);
        // timekeeper's jetton wallet
        const oracleJettonContract = blockchain.openContract(await ExampleJettonWallet.fromAddress(oracleWalletAddress));
        const mintTimekeeperResult = await mintToken(jettonMaster, timekeeper);
        let alarmIndex = 0;
        let buyNum = 1;
        let side = 0;
        let windResult = await windInJettonTransfer(timekeeper, oracle, alarmIndex, buyNum, side, transferValue);
        // Check that alarm count is 2 (Timekeeper will build a new alarm) 
        alarmIndexAfter = await oracle.getTotalAmount();
        expect(alarmIndexAfter).toEqual(2n);
        let AlarmAddress = await oracle.getGetAlarmAddress(1n);
        let alarmContract = blockchain.openContract(await Alarm.fromAddress(AlarmAddress));

        // Timekeeper2 send wind msg to take money from timekeeper1
        let timekeeper2: SandboxContract<TreasuryContract> = await blockchain.treasury('timekeeper2');
        await mintToken(jettonMaster, timekeeper2);
        let alarmIndex2 = 1;
        let buyNum2 = 1;
        let side2 = 0;
        let latestPrice = await oracle.getGetLatestBaseAssetPrice();
        let windResult2 = await windInJettonTransfer(timekeeper, oracle, alarmIndex2, buyNum2, side2, transferValue);
        latestPrice = await oracle.getGetLatestBaseAssetPrice();
        // Not Finished, cause for now the alarm contract that timekeeper2 build doesn't have baseprice
    });
});
