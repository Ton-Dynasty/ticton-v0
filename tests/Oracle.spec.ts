import { Alarm } from './../build/Oracle/tact_Alarm';
import { Blockchain, SandboxContract, TreasuryContract, printTransactionFees } from '@ton-community/sandbox';
import { Address, Cell, address, beginCell, toNano } from 'ton-core';
import { JettonTransfer, OracleV0 } from '../wrappers/Oracle_OracleV0';
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
    
    async function prepareAndSendJettonTransfer(watchmaker: SandboxContract<TreasuryContract>, oracle: SandboxContract<OracleV0>, baseAssetPriceAmount: number, baseAssetAmount: number, expireAt: number, transferValue: number) {
        const baseAssetPrice = toTic(baseAssetPriceAmount);
        const forwardTonAmount = toNano(toTic(baseAssetAmount) / baseAssetPrice) + toNano(0.5);
    
        const forwardInfo: Cell = beginCell()
            .storeUint(0, 8)
            .storeUint(expireAt, 256)
            .storeUint(baseAssetPrice, 256)
            .storeUint(1, 32)
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
        let baseAssetPriceAmount = 3;
        let baseAssetPrice = toTic(baseAssetPriceAmount);//Number(2.5 * 1000000) << 68;
        let baseAssetAmount = 10n * 1000000n;
        let forward_ton_amount = toNano(toTic(10)/baseAssetPrice) + toNano(0.5);
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
        
        // Check that oracle build alarm successfully
        let AlarmAddress = await oracle.getGetAlarmAddress(0n);
        expect(transfterResult.transactions).toHaveTransaction({
            from: oracle.address,
            to: AlarmAddress,
            success: true,
        });

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
        const transfterResult = await prepareAndSendJettonTransfer(watchmaker, oracle, baseAssetPriceAmount, baseAssetAmount, expireAt, transferValue);
    });
});
