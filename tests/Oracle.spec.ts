import { Alarm } from './../build/Oracle/tact_Alarm';
import { Blockchain, SandboxContract, TreasuryContract, printTransactionFees } from '@ton-community/sandbox';
import { Address, Cell, address, beginCell, toNano } from 'ton-core';
import { JettonTransfer, OracleV0, Tock } from '../wrappers/Oracle_OracleV0';
import { ExampleJettonMaster } from '../wrappers/Jetton_ExampleJettonMaster';
import { ExampleJettonWallet } from './../build/Jetton/tact_ExampleJettonWallet';
import '@ton-community/test-utils';

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

    async function mintTokensToWatchmaker(jettonMaster: SandboxContract<ExampleJettonMaster>, watchmaker: SandboxContract<TreasuryContract>) {
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
        const mintyResult = await mintTokensToWatchmaker(jettonMaster, watchmaker);
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
        const mintyResult = await mintTokensToWatchmaker(jettonMaster, watchmaker);
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
        const mintyResult = await mintTokensToWatchmaker(jettonMaster, watchmaker);
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
        const mintyResult = await mintTokensToWatchmaker(jettonMaster, watchmaker);
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
        const mintTimekeeperResult = await mintTokensToWatchmaker(jettonMaster, timekeeper);
        let alarmIndex = 0;
        let buyNum = 1;
        let side = 0;
        const forwardInfo: Cell = beginCell().storeUint(1,8).storeUint(alarmIndex,256).storeUint(buyNum,32).storeUint(side,32).endCell();
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
        printTransactionFees(windResult.transactions);

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

        expect(windResult.transactions).toHaveTransaction({
            from: oracleWalletAddress,
            to: oracle.address,
            success: true,
        });

        let AlarmAddress = await oracle.getGetAlarmAddress(0n);
        // Check that oracle build alarm successfully
        expect(windResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: AlarmAddress,
            success: true,
        });

        expect(windResult.transactions).toHaveTransaction({
            from: AlarmAddress,
            to: oracle.address,
            success: true,
        });

        let Alarm1Address = await oracle.getGetAlarmAddress(1n);
        expect(windResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: Alarm1Address,
            success: true,
        });

        expect(windResult.transactions).toHaveTransaction({
            from: Alarm1Address,
            to: timekeeper.address,
            success: true,
        });

    });
});
