import "@stdlib/deploy";
import "./packages/math/float.fc";
import "./packages/token/jetton/JettonMaster.tact";
import "./packages/token/jetton/JettonWallet.tact";

@name(toFloat)
native float(value: Int): Int;

@name(toInt)
native int(value: Int): Int;

@name(toFloat)
extends native float(self: Int): Int;

@name(safeAdd)
extends native add(self: Int, otherFloat: Int): Int;

@name(safeSub)
extends native sub(self: Int, otherFloat: Int): Int;

@name(safeMul)
extends native mul(self: Int, otherFloat: Int): Int;

@name(safeDiv)
extends native div(self: Int, otherFloat: Int): Int;

@name(muldiv)
extends native muldiv(self: Int, numerator: Int, denominator: Int): Int;

const BASEASSET_DECIMALS: Int = 1000000000; // 10 ** 9
const QUOTEASSET_DECIMALS: Int = 1000000; // 10 ** 6
const DEPLOY_FEE: Int = ton("0.05");
const STORAGE_FEE: Int = ton("0.019");
const CHECK_FEE: Int = ton("0.001");
const REFUND_FEE: Int = ton("0.02");
const REWARD_FEE: Int = ton("0.065");
const TRANSFER_FEE: Int = ton("0.02");
const MIN_BASEASSET_TRESHOLD: Int = ton("1"); // 1 ton
const TIMEPACE: Int = 60; // 1 minutes

trait Initializable {
    abstract inline fun requireInitialized();
    abstract inline fun requireNotInitialized();
}

struct AlarmMetadata{
    price: Int as uint256;
    createdAt: Int as uint32;
    remainScale: Int as uint32;
    baseAssetScale: Int as uint32;
    quoteAssetScale: Int as uint32;
}


// Tic Ton reward Token (TIC) contract
contract RewardJettonWallet with JettonWallet {
    balance: Int as coins = 0;
    owner: Address;
    jetton_master: Address;
    init(owner: Address, jetton_master: Address){
        self.owner = owner;
        self.jetton_master = jetton_master;
    }

    override inline fun calculate_jetton_wallet_init(owner_address: Address): StateInit {
        return initOf RewardJettonWallet(owner_address, self.jetton_master);
    }
}


contract OracleV1 with Deployable, Initializable, JettonMaster {
    // deploy
    owner: Address;
    // initialize
    baseAsset: Address; // e.g. TON
    quoteAsset: Address; // e.g. USDT
    baseAssetWallet: Address;
    quoteAssetWallet: Address;
    isInitialized: Bool;
    // calculated
    alarms: map<Address, AlarmMetadata>;
    latestBaseAssetPrice: Int = 0; // latest price of baseAsset
    latestTimestamp: Int = 0;
    // reward jetton configuration
    total_supply: Int as coins = 0;
    mintable: Bool = true;
    jetton_content: Cell;
    init(baseAsset: Address, quoteAsset: Address){
        self.owner = sender();
        self.isInitialized = false;
        self.baseAsset = baseAsset;
        self.quoteAsset = quoteAsset;
        self.baseAssetWallet = newAddress(0, 0);
        self.quoteAssetWallet = newAddress(0, 0);
        self.jetton_content = emptyCell();
    }

    inline fun requireAlarm(index: Int) {
        require(sender() == contractAddress(self._calculateAlarmInit(index)), "Only alarm can call this function");
    }

    override inline fun requireInitialized() {
        require(self.isInitialized == true, "Not initialized");
    }

    override inline fun requireNotInitialized() {
        require(self.isInitialized == false, "Already initialized");
    }

    override inline fun calculate_jetton_wallet_init(owner_address: Address): StateInit {
        return initOf RewardJettonWallet(owner_address, myAddress());
    }

    // Initialize message is used to initialize the Oracle.
    // It will set jetton wallet address for both base asset and quote asset, and it also set the reward jetton content.
    // Before initialization, all method in this contract will be blocked.
    receive(msg: Initialize){
        require(self.isInitialized == false, "Already initialized");
        require(sender() == self.owner, "Only owner can initialize");
        require(msg.baseAssetWallet == newAddress(0, 0), "Only support TON as baseAsset");
        self.owner = myAddress();
        self.isInitialized = true;
        self.baseAssetWallet = msg.baseAssetWallet;
        self.quoteAssetWallet = msg.quoteAssetWallet;
        self.jetton_content = msg.rewardJettonContent;
    }



    // After oracle receives JettonTransferNotification msg, it will first check is Tick or Wind
    // If it is Tick, then it will check the sending ton is enough to build a new alarm by sending Tock msg.
    // If it is Wind, then it will send Reset message to the alarm, and check whether Timekeeper can abirtrage in the alarm contract
    receive(msg: JettonTransferNotification){
        let ctx: Context = context();
        if (self.isInitialized == false) {
            // Return jetton back if gas is enough
            // WARNING: Don't return jetton if the oracle is not initialized
            send(SendParameters{to: ctx.sender, value: ((ctx.value - ctx.readForwardFee()) - STORAGE_FEE), mode: 0});
            return ;
        }
        require(ctx.sender == self.quoteAssetWallet, "Only oracle quoteAsset wallet can send notification to oracle");

        let result = self.alarms.get(ctx.sender);
        // Parse the payload to see if it is Tick or Wind
        let payload: Slice = msg.forward_payload;
        let ref: Cell = payload.loadRef();
        let sc: Slice = ref.beginParse();
        let opCode: Int = sc.loadUint(8); // 0 means Tick, 1 means Wind
        let value: Int = ((ctx.value - ctx.readForwardFee()) - STORAGE_FEE);
        if (opCode == 0) {
            // Method: Tick
            let currentTimestamp: Int = now();
            let expireAt: Int = sc.loadUint(256);
            let baseAssetPrice: Int = sc.loadUint(256); // The first 156 bits is integer part, the last 100 bits is float part
            // If now() is larger than expireAt, then return the funds back to the Watchmaker if value is enough to pay the gas
            if ((currentTimestamp > expireAt && value > 0) || result!=null) {
                // Return jetton back if gas is enough
                if (self.quoteAssetWallet != newAddress(0, 0)) {
                    send(SendParameters{
                            to: self.quoteAssetWallet,
                            value: value,
                            mode: 0,
                            body: JettonTransfer{
                                query_id: 0,
                                amount: msg.amount,
                                destination: msg.sender,
                                response_destination: msg.sender,
                                custom_payload: null,
                                forward_ton_amount: 0,
                                forward_payload: emptySlice()
                            }.toCell()
                        }
                    );
                }
                return ;
            }
            // Preserve the baseAssetAmount
            let needBaseAssetAmount: Int = msg.amount.float().div(baseAssetPrice);
            
            // Oracle can accept the tolerance caused by float calculation
            let tmp: Int = ctx.readForwardFee();
            let tolerance: Int = needBaseAssetAmount - MIN_BASEASSET_TRESHOLD.float();
            if (tolerance < 0) {
                require((-tolerance) < 10000000000000, "baseAssetAmount is too small");
                needBaseAssetAmount = int(MIN_BASEASSET_TRESHOLD.float() + tolerance);
            }
            else {
                needBaseAssetAmount = int(needBaseAssetAmount);
            }
            
            require(ctx.value > (needBaseAssetAmount + ctx.readForwardFee() + STORAGE_FEE),
                "Insufficient funds to pay for the gas"
            );
            nativeReserve(needBaseAssetAmount, 0);
            let sendBackAmount: Int = ctx.value - (needBaseAssetAmount + ctx.readForwardFee() + STORAGE_FEE);
        
            self.alarms.set(ctx.sender, AlarmMetadata{
                price: baseAssetPrice,
                createdAt: currentTimestamp,
                remainScale: 1,
                baseAssetScale: needBaseAssetAmount,
                quoteAssetScale: msg.amount
            });
            
            self.totalAlarms = (self.totalAlarms + 1);
            return ;
        }
        if (opCode == 1) {
            // Method: Wind
            // TimeKeepers send Reset message to the alarm, reply with Sync message
            let alarmOwner: Address = sc.loadAddress();
            let buyNum: Int = sc.loadUint(32);
            let newBaseAssetPrice: Int = sc.loadUint(256);
            let oldAlarm = self.alarms.get(alarmOwner)
            require(result != null, "Alarm not found");
            if (newBaseAssetPrice > oldAlarm.price) {
                // Buy baseAsset
                // For example, need usdt amount = (new price * (buy amount*2) + original price * buy amount)
                // need ton amount = (buy amount * 2) - the amount you buy from this alarm
                needQuoteAssetAmount = int((newBaseAssetPrice * (buyNum << 1) + oldAlarm.price * buyNum) * MIN_BASEASSET_TRESHOLD);
                needBaseAssetAmount = buyNum * MIN_BASEASSET_TRESHOLD;
            } else {
                // Buy quoteAsset, put baseAsset into the alarm
                needQuoteAssetAmount = int((newBaseAssetPrice * (buyNum << 1) - oldAlarm.price * buyNum) * MIN_BASEASSET_TRESHOLD);
                needBaseAssetAmount = buyNum * 3 * MIN_BASEASSET_TRESHOLD;
            }

            let remainBaseAssetAmount = oldAlarm.remainScale * MIN_BASEASSET_TRESHOLD;
            let remainQuoteAssetAmount = oldAlarm.quoteAssetScale;

            // Check base asset and quote asset is sufficient
            refundBaseAssetAmount = (remainBaseAssetAmount - needBaseAssetAmount);
            refundQuoteAssetAmount = (remainQuoteAssetAmount - needQuoteAssetAmount);

            // If refundBaseAssetAmount/refundQuoteAssetAmount is negative, then it means the TimeKeeper doesn't have enough asset to buy
            if (refundQuoteAssetAmount < 0 || refundBaseAssetAmount < 0) {
                // no enough asset to arbitrage, send refund message back to oracle and exit
                send(SendParameters{
                        to: self.oracleAddress,
                        value: (remainBaseAssetAmount - REFUND_FEE),
                        mode: SendIgnoreErrors,
                        body: Refund{
                            alarmIndex: self.index,
                            refundQuoteAssetAmount: quoteAssetAmount,
                            receiver: sender
                        }.toCell()
                    }
                );
                return ;
            }

            if (newBaseAssetPrice > self.baseAssetPrice) {
                // TimeKeeper take baseAsset away, so decrease baseAssetScale and increase quoteAssetScale
                oldAlarm.baseAssetScale = (oldAlarm.baseAssetScale - buyNum);
                oldAlarm.quoteAssetScale = (oldAlarm.quoteAssetScale + buyNum);
                oldAlarm.remainScale = (oldAlarm.remainScale - buyNum);
            } else {
                // TimeKeeper take quoteAsset away, so increase baseAssetScale and decrease quoteAssetScale
                oldAlarm.baseAssetScale = (oldAlarm.baseAssetScale + buyNum);
                oldAlarm.quoteAssetScale = (oldAlarm.quoteAssetScale - buyNum);
                oldAlarm.remainScale = (oldAlarm.remainScale - buyNum);
            }

            self.alarms.set(alarmOwner, oldAlarm);
            self.alarms.set(ctx.sender, AlarmMetadata{
                price: newBaseAssetPrice,
                createdAt: now(),
                remainScale: buyNum << 1,
                baseAssetScale: buyNum << 1,
                quoteAssetScale: buyNum << 1
            });

            // refund asset back to TimeKeeper
            send(SendParameters{
                    to: self.quoteAssetWallet,
                    value: 0,
                    mode: SendRemainingValue,
                    body: JettonTransfer{
                        query_id: 0,
                        amount: refundQuoteAssetAmount,
                        destination: ctx.sender,
                        response_destination: ctx.sender,
                        custom_payload: null,
                        forward_ton_amount: 0,
                        forward_payload: emptySlice()
                    }.toCell()
                }
            );
            return ;
        }
    }

    // Watchmaker sends Ring message to close the quotation (alarm)
    receive(msg: "Ring"){
        self.requireInitialized();
        // Watchmaker sends Ring message to Mute a specific alarm
        let alarm: AlarmMetadata = self.alarms.get(sender());
        require(alarm != null, "alarm not found");
        let reward: Int = 0;
        if (alarm.remainScale > 0)  {
            reward = self.sync(now(), alarm.price);
        }
        self.alarms.delete(sender());
        if (alarm.remainQuoteAssetScale > 0) {
            let sendValue: Int = ((alarm.extraBaseAssetAmount  - STORAGE_FEE) - ctx.readForwardFee() - REWARD_FEE) - REFUND_FEE - TRANSFER_FEE;
            // The remain quote token is calculated by the formula:
            send(SendParameters{
                    to: self.quoteAssetWallet,
                    value: (alarm.remainBaseAssetScale * MIN_BASEASSET_TRESHOLD + sendValue ),
                    mode: SendPayGasSeparately,
                    body: JettonTransfer{
                        query_id: 0,
                        amount: alarm.quoteAssetAmount,
                        destination: alarm.watchmaker,
                        response_destination: alarm.watchmaker,
                        custom_payload: null,
                        forward_ton_amount: 0,
                        forward_payload: emptySlice()
                    }.toCell()
                }
            );
        } else if (alarm.remainBaseAssetScale > 0) {
            //  Refund TON
            let standardRefundAmount: Int =
                (((alarm.extraBaseAssetAmount - STORAGE_FEE) - ctx.readForwardFee()) - REFUND_FEE - REWARD_FEE);
            send(SendParameters{
                    to: alarm.watchmaker,
                    value: (alarm.remainBaseAssetScale * MIN_BASEASSET_TRESHOLD + standardRefundAmount),
                    mode: 0,
                    body: "SlickBack".asComment()
                }
            );
        }

        // If this Ring have reward, then send the TIC to the Watchmaker
        if (rewardAmount > 0) {
            send(SendParameters{
                    to: myAddress(),
                    value: REWARD_FEE,
                    mode: SendPayGasSeparately,
                    body: JettonMint{
                        origin: myAddress(),
                        receiver: sender(),
                        amount: rewardAmount,
                        custom_payload: null,
                        forward_ton_amount: 0,
                        forward_payload: emptySlice()
                    }.toCell()
                }
            );
        }
    }

    // When receiving Check message, it will send the price to the sender that requested
    receive(msg: Check){
        // Protocols send Check message to query the price
        self.requireInitialized();
        require(msg.quoteIndex == 0 && msg.quoteIndex == 1, "quoteIndex must be either 0 or 1");
        let ctx: Context = context();
        let remain: Int = (((ctx.value - STORAGE_FEE) - ctx.readForwardFee()) - CHECK_FEE);

        // Send baseAsset price to the sender
        if (msg.quoteIndex == 0) {
            send(SendParameters{
                    to: sender(),
                    value: remain,
                    mode: SendPayGasSeparately,
                    body: Announce{
                        queryID: msg.queryID,
                        quoteAsset: self.baseAsset,
                        timestamp: self.latestTimestamp,
                        price: self.latestBaseAssetPrice
                    }.toCell()
                }
            );
            return ;
        }

        // Send quoteAsset price to the sender
        if (msg.quoteIndex == 1) {
            let latestQuoteAssetPrice: Int = float(1).div(self.latestBaseAssetPrice); // remember user should >> 64 to get the integer part
            send(SendParameters{
                    to: sender(),
                    value: remain,
                    mode: SendPayGasSeparately,
                    body: Announce{
                        queryID: msg.queryID,
                        quoteAsset: self.quoteAsset,
                        timestamp: self.latestTimestamp,
                        price: latestQuoteAssetPrice
                    }.toCell()
                }
            );
            return ;
        }
    }

 
    // Sync the price and return the reward
    inline fun sync(timestamp: Int, baseAssetPrice: Int): Int {
        // TODO: Calculate the weighted average of the baseAssetPrice
        // For testing purpose, we just use (9*old + new) / 10
        // Actual formula:
        // d = (new timestamp - old timestamp) / TIMEPACE
        // w = 0.9 * {1 - [1 / (1 - d^2)]^2}
        if (now() <= (timestamp + TIMEPACE)) {
            return 0;
        }
        if (timestamp <= self.latestTimestamp || baseAssetPrice == 0) {
            // Ignore the old timestamp
            return 0;
        }
        if (self.latestTimestamp == 0) {
            self.latestTimestamp = timestamp;
            self.latestBaseAssetPrice = baseAssetPrice;
            return TIMEPACE * QUOTEASSET_DECIMALS;
        }
        self.latestBaseAssetPrice = (9 * self.latestBaseAssetPrice + baseAssetPrice) / 10;
        let reward: Int = (timestamp - self.latestTimestamp) / TIMEPACE;
        if (reward > 0) {
            return reward  * QUOTEASSET_DECIMALS;
        }
        return 0;
    }

    inline fun _calculateAlarmInit(index: Int): StateInit {
        return initOf Alarm(index, myAddress());
    }

    // Get Methods

    // Get alarm address by alarm index
    get fun getAlarmAddress(index: Int): Address {
        let initCode: StateInit = self._calculateAlarmInit(index);
        return contractAddress(initCode);
    }


    // Get the latest price of the baseAsset
    get fun getLatestBaseAssetPrice(): Int {
        return self.latestBaseAssetPrice;
    }

    // Get Oracle's Ton balance
    get fun getMyBalance(): Int {
        return myBalance();
    }

    // Get the metadata of the Oracle
    get fun getOracleData(): OracleMetadata {
        return OracleMetadata {
            base_asset_address: self.baseAsset,
            quote_asset_address: self.quoteAsset,
            base_asset_decimals: 9, // TODO: for POC version only, we will remove this v1
            quote_asset_decimals: 6, // TODO: for POC version only, we will remove this v1
            min_base_asset_threshold: MIN_BASEASSET_TRESHOLD,
            base_asset_wallet_address: self.baseAssetWallet,
            quote_asset_wallet_address: self.quoteAssetWallet,
            isInitialized: self.isInitialized,
            latestBaseAssetPrice: self.latestBaseAssetPrice,
            latestTimestamp: self.latestTimestamp,
            totalAlarms: 0 // For compatibility with v0
        };
    }
}