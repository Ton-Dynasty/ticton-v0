import "@stdlib/deploy";
import "./packages/math/float.fc";
import "./packages/token/jetton/JettonMaster.tact";
import "./packages/token/jetton/JettonWallet.tact";

@name(toFloat)
native float(value: Int): Int;

@name(toInt)
native int(value: Int): Int;

// @name(abs)
// native abs(value: Int): Int;

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


message Initialize {
    baseAssetWallet: Address; // e.g. jetton wallet address for TON, which is 0
    quoteAssetWallet: Address; // e.g. jetton wallet address for USDT
    rewardJettonContent: Cell; // reward token jetton content
}
message Refund {
    alarmIndex: Int as uint256; // the interacted alarm index
    refundQuoteAssetAmount: Int; // The amount of jetton to refund
    receiver: Address; // the receiver of the jetton and tons
}
message Tick {
    expireAt: Int as uint256; // If now() is larger than expireAt, then return the funds back to the Watchmaker if value is enough to pay the gas
    baseAssetPrice: Int as uint256; // baseAsset price relative to quoteAsset
}
message Tock {
    alarmIndex: Int as uint256; // the interacted alarm index
    scale: Int as uint32;
    createdAt: Int;
    watchmaker: Address;
    baseAssetPrice: Int; // baseAsset price relative to quoteAsset (e.g. baseAssetPrice=2.5 means 1 TON = 2.5 USDT)
}
message Wind {
    alarmIndex: Int as uint256; // the interacted alarm index
    buyNum: Int as uint32; // how many scale to buy
    newBaseAssetPrice: Int as uint256; // new baseAsset price relative to quoteAsset in fixed point float
}
message Reset {
    sender: Address;
    buyNum: Int; // The number of scales to buy
    quoteAssetAmount: Int; // The amount of quoteAsset oracle received
    newBaseAssetPrice: Int; // The new baseAsset price relative to quoteAsset
}
message Sync {
    baseAssetPrice: Int as uint256; // quoteAsset amount to buy 1 baseAsset
    createdAt: Int;
}
message Ring {
    queryID: Int;
    alarmIndex: Int; // to get the alarm address, call getAlarm(alarmIndex)
}
message Mute {
    queryID: Int;
    watchmaker: Address;
}
message Check {
    queryID: Int;
    quoteIndex: Int; // 0 for baseAsset, 1 for quoteAsset
}
message Announce {
    queryID: Int;
    quoteAsset: Address;
    timestamp: Int;
    price: Int;
}
message Chronoshift {
    queryID: Int;
    alarmIndex: Int;
    createdAt: Int;
    watchmaker: Address;
    baseAssetPrice: Int as uint256;
    remainScale: Int;
    remainBaseAssetScale: Int;
    remainQuoteAssetScale: Int;
    extraBaseAssetAmount: Int;
    extraQuoteAssetAmount: Int;
}
message Chime {
    alarmIndex: Int;
    timeKeeper: Address;
    newBaseAssetPrice: Int as uint256;
    newScale: Int;
    refundQuoteAssetAmount: Int;
    baseAssetPrice: Int as uint256;
    createdAt: Int;
    remainScale: Int;
    preserveBaseAssetAmount: Int; // Tell oracle to preserve exactly this amount of baseAsset
}

struct EstimateResult {
    canBuy: Bool;
    needBaseAssetAmount: Int;
    needQuoteAssetAmount: Int;
} 

struct OracleMetadata {
    base_asset_address: Address;
    quote_asset_address: Address;
    base_asset_decimals: Int;
    quote_asset_decimals: Int;
    min_base_asset_threshold: Int;
    base_asset_wallet_address: Address;
    quote_asset_wallet_address: Address;
    is_initialized: Bool;
    latestBaseAssetPrice: Int;
    latestTimestamp: Int;
    totalAlarms: Int;
}

struct AlarmMetadata{
    watchmaker: Address;
    baseAssetScale: Int;
    quoteAssetScale: Int;
    remainScale: Int;
    baseAssetPrice: Int;
    baseAssetAmount: Int;
    quoteAssetAmount: Int;
    createdAt: Int;
    alarmIndex: Int;
}

const BASEASSET_DECIMALS: Int = 1000000000;
const QUOTEASSET_DECIMALS: Int = 1000000;
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

contract Alarm with Initializable {
    index: Int = 0;
    createdAt: Int = 0;
    watchmaker: Address;
    oracleAddress: Address;
    baseAssetScale: Int = 0;
    quoteAssetScale: Int = 0;
    remainScale: Int = 0;
    baseAssetPrice: Int = 0;
    baseAssetAmount: Int = 0;
    quoteAssetAmount: Int = 0;
    init(index: Int, oracle: Address){
        self.index = index;
        self.oracleAddress = oracle;
        self.watchmaker = newAddress(0, 0);
    }

    override inline fun requireInitialized() {
        require(self.oracleAddress != newAddress(0, 0), "Not initialized");
    }

    override inline fun requireNotInitialized() {
        // MODIFIED: Change from oracle address to watchmaker address
        require(self.watchmaker == newAddress(0, 0), "Already initialized");
    }

    inline fun requireOracle(sender: Address) {
        require(sender == self.oracleAddress, "Only oracle can call this function");
    }

    receive(msg: Tock){
        // Receive a Tock message from the Oracle, should initialize the parameters
        // This function should be called only once with contract creation
        let sender: Address = sender();
        // Check the request is valid
        self.requireNotInitialized();
        self.requireOracle(sender);
        // Initialize the parameters
        self.createdAt = now();
        self.oracleAddress = sender;
        self.watchmaker = msg.watchmaker;
        self.baseAssetScale = msg.scale;
        self.quoteAssetScale = msg.scale;
        self.remainScale = msg.scale;
        self.baseAssetPrice = msg.baseAssetPrice;
        self.baseAssetAmount = msg.scale * MIN_BASEASSET_TRESHOLD;
        self.quoteAssetAmount = int(msg.scale * MIN_BASEASSET_TRESHOLD * msg.baseAssetPrice);
        // Return the remaining funds back to the Watchmaker
        let ctx: Context = context();
        send(SendParameters{
                to: self.watchmaker,
                value: 0,
                mode: SendRemainingValue,
                body: "Alarm initialized".asComment()
            }
        );
    }

    receive(msg: Reset){
        // When receiving Reset message, first validate the baseAsset and quoteAsset balance
        // Then send Sync message to the Oracle to update the price
        // Steps:
        // 0. Check if the message is from Oracle
        // 1. increase/decrease baseAssetScale and quoteAssetScale, depends on the buyNum and quoteIndex (0 to decrease baseAssetScale and increase quoteAssetScale)
        // 2. Send Sync message to the Oracle if time is smaller than (createdAt + validLifetime)
        // 3. Send Chime message to the Oracle to create a new alarm
        let ctx: Context = context();
        self.requireOracle(ctx.sender);
        let remainBaseAssetAmount: Int = ((ctx.value - STORAGE_FEE) - ctx.readForwardFee());
        if (self.remainScale < msg.buyNum) {
            // send refund message back to oracle and exit
            send(SendParameters{
                    to: self.oracleAddress,
                    value: (remainBaseAssetAmount - REFUND_FEE),
                    mode: SendIgnoreErrors,
                    body: Refund{
                        alarmIndex: self.index,
                        refundQuoteAssetAmount: msg.quoteAssetAmount,
                        receiver: msg.sender
                    }.toCell()
                }
            );
            return ;
        }
        let failed: Bool = false;
        let refundBaseAssetAmount: Int = 0; // 0 means return as much as possible
        let refundQuoteAssetAmount: Int = 0;
        let baseAssetPrice: Int = 0;
        let needBaseAssetAmount: Int = 0;
        let needQuoteAssetAmount: Int = 0;
        if (msg.newBaseAssetPrice > self.baseAssetPrice) {
            // Buy baseAsset
            if (self.baseAssetScale < msg.buyNum) {
                failed = true;
            } else {
                // For example, need usdt amount = (new price * (buy amount*2) + original price * buy amount)
                // need ton amount = (buy amount * 2) - the amount you buy from this alarm
                needQuoteAssetAmount = int((msg.newBaseAssetPrice * (msg.buyNum << 1) + self.baseAssetPrice * msg.buyNum) * MIN_BASEASSET_TRESHOLD);
                needBaseAssetAmount = msg.buyNum * MIN_BASEASSET_TRESHOLD;
            }
        } else {
            // Buy quoteAsset, put baseAsset into the alarm
            if (self.quoteAssetScale < msg.buyNum) {
                failed = true;
            } else {
                needQuoteAssetAmount = int((msg.newBaseAssetPrice * (msg.buyNum << 1) - self.baseAssetPrice * msg.buyNum) * MIN_BASEASSET_TRESHOLD);
                needBaseAssetAmount = msg.buyNum * 3 * MIN_BASEASSET_TRESHOLD;
            }
        }
        if (failed) {
            // send refund message back to oracle and exit
            send(SendParameters{
                    to: self.oracleAddress,
                    value: (remainBaseAssetAmount - REFUND_FEE),
                    mode: SendIgnoreErrors,
                    body: Refund{
                        alarmIndex: self.index,
                        refundQuoteAssetAmount: msg.quoteAssetAmount,
                        receiver: msg.sender
                    }.toCell()
                }
            );
            return ;
        }
        // Check base asset and quote asset is sufficient
        refundBaseAssetAmount = (remainBaseAssetAmount - needBaseAssetAmount);
        refundQuoteAssetAmount = (msg.quoteAssetAmount - needQuoteAssetAmount);
        if (refundQuoteAssetAmount < 0 || refundBaseAssetAmount < 0) {
            // no enough asset to arbitrage, send refund message back to oracle and exit
            send(SendParameters{
                    to: self.oracleAddress,
                    value: (remainBaseAssetAmount - REFUND_FEE),
                    mode: SendIgnoreErrors,
                    body: Refund{
                        alarmIndex: self.index,
                        refundQuoteAssetAmount: msg.quoteAssetAmount,
                        receiver: msg.sender
                    }.toCell()
                }
            );
            return ;
        }
        if (msg.newBaseAssetPrice <= self.baseAssetPrice) {
            self.quoteAssetAmount =
                (self.quoteAssetAmount - int(self.baseAssetPrice.mul(msg.buyNum)) * QUOTEASSET_DECIMALS);
        } else {
            self.quoteAssetAmount =
                (self.quoteAssetAmount + int(self.baseAssetPrice.mul(msg.buyNum)) * QUOTEASSET_DECIMALS);
        }
        if (self.remainScale > 0) {
            baseAssetPrice = self.baseAssetPrice;
        }
        send(SendParameters{
                to: ctx.sender,
                value: 0,
                mode: SendRemainingValue,
                body: Chime{
                    alarmIndex: self.index,
                    timeKeeper: msg.sender,
                    newBaseAssetPrice: msg.newBaseAssetPrice, // Change to the new baseAssetPrice
                    newScale: msg.buyNum << 1,
                    refundQuoteAssetAmount: refundQuoteAssetAmount,
                    baseAssetPrice: baseAssetPrice,
                    createdAt: self.createdAt,
                    remainScale: self.remainScale,
                    preserveBaseAssetAmount: needBaseAssetAmount
                }.toCell()
            }
        );
        // Update scales if all actions successfully
        if (msg.newBaseAssetPrice > self.baseAssetPrice) {
            // TimeKeeper take baseAsset away, so decrease baseAssetScale and increase quoteAssetScale
            self.baseAssetScale = (self.baseAssetScale - msg.buyNum);
            self.quoteAssetScale = (self.quoteAssetScale + msg.buyNum);
            self.remainScale = (self.remainScale - msg.buyNum);
        } else {
             // TimeKeeper take quoteAsset away, so increase baseAssetScale and decrease quoteAssetScale
            self.baseAssetScale = (self.baseAssetScale + msg.buyNum);
            self.quoteAssetScale = (self.quoteAssetScale - msg.buyNum);
            self.remainScale = (self.remainScale - msg.buyNum);
        }
    }

    receive(msg: Mute){
        // TODO: When a Watchmaker wishes to mute an alarm
        // the alarm should reset the owner, then send Chronoshift message to the Watchmaker
        // Meanwhile, the oracle should receive a Sync message to update the price if the scale is not 0
        require(sender() == self.oracleAddress, "Only oracle can mute an alarm");
        let ctx: Context = context();
        require(msg.watchmaker == self.watchmaker, "Only watchmaker can mute an alarm");
        let extraBaseAssetAmount: Int = ctx.value; //abs((self.baseAssetAmount - self.baseAssetScale * MIN_BASEASSET_TRESHOLD));
        send(SendParameters{
                to: self.oracleAddress,
                value: 0,
                mode: (SendRemainingBalance + SendDestroyIfZero),
                body: Chronoshift{
                    queryID: msg.queryID,
                    alarmIndex: self.index,
                    createdAt: self.createdAt,
                    watchmaker: self.watchmaker,
                    baseAssetPrice: self.baseAssetPrice,
                    remainScale: self.remainScale,
                    remainBaseAssetScale: self.baseAssetScale,
                    remainQuoteAssetScale: self.quoteAssetScale,
                    extraBaseAssetAmount: extraBaseAssetAmount,
                    extraQuoteAssetAmount: self.quoteAssetAmount
                }.toCell()
            }
        );
    }

    // Get Methods
    get fun getAlarmMetadata(): AlarmMetadata {
        return AlarmMetadata{
            watchmaker: self.watchmaker,
            baseAssetScale: self.baseAssetScale,
            quoteAssetScale: self.quoteAssetScale,
            remainScale: self.remainScale,
            baseAssetPrice: self.baseAssetPrice,
            baseAssetAmount: self.baseAssetAmount,
            quoteAssetAmount: self.quoteAssetAmount,
            createdAt: self.createdAt,
            alarmIndex: self.index
        };
    }

    get fun getEstimate(buyNum: Int, newBaseAssetPrice: Int): EstimateResult {
        let needBaseAssetAmount: Int = 0;
        let needQuoteAssetAmount: Int = 0;
        let canBuy: Bool = true;
        if (self.remainScale < buyNum || self.baseAssetScale < buyNum || self.quoteAssetScale < buyNum) {
            canBuy = false;
        }
        else {
            if (newBaseAssetPrice > self.baseAssetPrice) {
                // Buy baseAsset
                needQuoteAssetAmount = int((newBaseAssetPrice * (buyNum << 1) + self.baseAssetPrice * buyNum) * MIN_BASEASSET_TRESHOLD);
                needBaseAssetAmount = buyNum * MIN_BASEASSET_TRESHOLD;
                
            } else {
                // Buy quoteAsset
                needQuoteAssetAmount = int((newBaseAssetPrice * (buyNum << 1) - self.baseAssetPrice * buyNum) * MIN_BASEASSET_TRESHOLD);
                needBaseAssetAmount = buyNum * 3 * MIN_BASEASSET_TRESHOLD;
            }
        }
        return EstimateResult{
            canBuy: canBuy,
            needBaseAssetAmount: needBaseAssetAmount,
            needQuoteAssetAmount: needQuoteAssetAmount
        };
    }


}

contract OracleV0 with Deployable, Initializable, JettonMaster {
    // deploy
    owner: Address;
    // initialize
    baseAsset: Address; // ton
    quoteAsset: Address; // usdt
    baseAssetWallet: Address;
    quoteAssetWallet: Address;
    is_initialized: Bool;
    // calculated
    totalAlarms: Int = 0;
    latestBaseAssetPrice: Int = 0; // latest price of baseAsset
    latestTimestamp: Int = 0;
    // reward jetton configuration
    total_supply: Int as coins = 0;
    mintable: Bool = true;
    jetton_content: Cell;
    init(baseAsset: Address, quoteAsset: Address){
        self.owner = sender();
        self.is_initialized = false;
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
        require(self.is_initialized == true, "Not initialized");
    }

    override inline fun requireNotInitialized() {
        require(self.is_initialized == false, "Already initialized");
    }

    override inline fun calculate_jetton_wallet_init(owner_address: Address): StateInit {
        return initOf RewardJettonWallet(owner_address, myAddress());
    }

    receive(msg: Initialize){
        require(self.is_initialized == false, "Already initialized");
        require(sender() == self.owner, "Only owner can initialize");
        require(msg.baseAssetWallet == newAddress(0, 0), "Only support TON as baseAsset");
        self.owner = myAddress();
        self.is_initialized = true;
        self.baseAssetWallet = msg.baseAssetWallet;
        self.quoteAssetWallet = msg.quoteAssetWallet;
        self.jetton_content = msg.rewardJettonContent;
    }

    receive(msg: Refund){
        // msg.refundQuoteAssetAmount
        // msg.receiver
        self.requireAlarm(msg.alarmIndex);
        let ctx: Context = context();
        send(SendParameters{
                to: self.quoteAssetWallet,
                value: 0,
                mode: SendRemainingValue,
                body: JettonTransfer{
                    query_id: 0,
                    amount: msg.refundQuoteAssetAmount,
                    destination: msg.receiver,
                    response_destination: msg.receiver,
                    custom_payload: null,
                    forward_ton_amount: 0,
                    forward_payload: emptySlice()
                }.toCell()
            }
        );
    }

    receive(msg: JettonTransferNotification){
        let ctx: Context = context();
        if (self.is_initialized == false) {
            // Return jetton back if gas is enough
            // WARNING: Don't return jetton if the oracle is not initialized
            send(SendParameters{to: ctx.sender, value: ((ctx.value - ctx.readForwardFee()) - STORAGE_FEE), mode: 0});
            return ;
        }
        require(ctx.sender == self.quoteAssetWallet, "Only oracle quoteAsset wallet can send notification to oracle");
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
            if (currentTimestamp > expireAt && value > 0) {
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
            
            let tmp: Int = ctx.readForwardFee();
            //require(needBaseAssetAmount >= MIN_BASEASSET_TRESHOLD, "baseAssetAmount is too small");
            let tolerance: Int = needBaseAssetAmount - MIN_BASEASSET_TRESHOLD.float();
            if (tolerance < 0) {
                // If we qoute 2.2 ton/usdt, we will get 999999999.9999999 which is less than 1 ton. So we need to add a tolerance 10000000000000
                require(abs(tolerance) < 10000000000000, "baseAssetAmount is too small");
                needBaseAssetAmount = int(MIN_BASEASSET_TRESHOLD.float() + tolerance);
            }
            else {
                needBaseAssetAmount = int(needBaseAssetAmount);
            }
            
            //require(abs(needBaseAssetAmount - msg.amount) < 1000000000, "baseAssetAmount is too small");
            require(ctx.value > (needBaseAssetAmount + 2 * ctx.readForwardFee() + STORAGE_FEE),
                "Insufficient funds to pay for the gas"
            );
            nativeReserve(needBaseAssetAmount, 0);
            let sendBackAmount: Int = ctx.value - (needBaseAssetAmount + 2 * ctx.readForwardFee() + STORAGE_FEE);

            // Open a new alarm
            let initCode: StateInit = self._calculateAlarmInit(self.totalAlarms);
            send(SendParameters{
                    to: contractAddress(initCode),
                    value: sendBackAmount,
                    mode: SendIgnoreErrors,
                    body: Tock{
                        alarmIndex: self.totalAlarms,
                        scale: 1,
                        createdAt: currentTimestamp,
                        watchmaker: msg.sender,
                        baseAssetPrice: baseAssetPrice
                    }.toCell(),
                    code: initCode.code,
                    data: initCode.data
                }
            );
            self.totalAlarms = (self.totalAlarms + 1);
            return ;
        }
        if (opCode == 1) {
            // Method: Wind
            // TimeKeepers send Reset message to the alarm, reply with Sync message
            let alarmIndex: Int = sc.loadUint(256);
            let buyNum: Int = sc.loadUint(32);
            let newBaseAssetPrice: Int = sc.loadUint(256);
            require(alarmIndex < self.totalAlarms, "alarmIndex out of range");
            // Send Reset message to Alarm contract. Because we cannot evaluate the ton is sufficient in oracle
            // so we forward all tons to the alarm contract, but preserve received jettons in the oracle
            send(SendParameters{
                    to: contractAddress(self._calculateAlarmInit(alarmIndex)),
                    value: (ctx.value - STORAGE_FEE),
                    mode: 0,
                    body: Reset{
                        sender: msg.sender,
                        buyNum: buyNum,
                        quoteAssetAmount: msg.amount,
                        newBaseAssetPrice: newBaseAssetPrice
                    }.toCell()
                }
            );
            return ;
        }
    }

    receive(msg: Ring){
        self.requireInitialized();
        // Watchmaker sends Ring message to Mute a specific alarm
        require(msg.alarmIndex < self.totalAlarms, "alarmIndex out of range");
        let alarmAddress: Address = self.getAlarmAddress(msg.alarmIndex);
        
        send(SendParameters{
                to: alarmAddress,
                value: 0,
                mode: SendRemainingValue,
                body: Mute{
                    queryID: msg.queryID,
                    watchmaker: sender()
                }.toCell()
            }
        );
    }

    receive(msg: Chime){
        // Should Receive Chime message from Alarm contract
        self.requireInitialized();
        self.requireAlarm(msg.alarmIndex);
        
        // Preserve exactly the amount of baseAsset
        nativeReserve(msg.preserveBaseAssetAmount, 0);

        // if remainScale is not 0, then update the price in oracle
        if (msg.remainScale > 0) {
            self.sync(msg.createdAt, msg.baseAssetPrice);
        }
        // Deploy a new alarm contract
        let initCode: StateInit = self._calculateAlarmInit(self.totalAlarms);
        send(SendParameters{
                to: contractAddress(initCode),
                value: DEPLOY_FEE,
                mode: 0,
                body: Tock{
                    alarmIndex: self.totalAlarms,
                    createdAt: now(),
                    scale: msg.newScale,
                    watchmaker: msg.timeKeeper,
                    baseAssetPrice: msg.newBaseAssetPrice
                }.toCell(),
                code: initCode.code,
                data: initCode.data
            }
        );
        self.totalAlarms = (self.totalAlarms + 1);
        // Transfer the remaining funds or profits to the TimeKeeper
        let ctx: Context = context();
        let standardRefundAmount: Int = ((ctx.value) - ctx.readForwardFee() - DEPLOY_FEE - REFUND_FEE - msg.preserveBaseAssetAmount);
        if (msg.refundQuoteAssetAmount > 0) {
            // Send Jetton Transfer message to refund
            send(SendParameters{
                    to: self.quoteAssetWallet,
                    value: standardRefundAmount,
                    mode: SendPayGasSeparately,
                    body: JettonTransfer{
                        query_id: 0,
                        amount: msg.refundQuoteAssetAmount,
                        destination: msg.timeKeeper,
                        response_destination: msg.timeKeeper,
                        custom_payload: null,
                        forward_ton_amount: 0,
                        forward_payload: emptySlice()
                    }.toCell()
                }
            );
            return ;
        }
        if (standardRefundAmount > 0) {
            send(SendParameters{
                to: msg.timeKeeper, 
                value: standardRefundAmount,
                mode: SendPayGasSeparately, 
                body: "SlickBack".asComment()
            });
            return ;
        }
    }

    receive(msg: Check){
        // Protocols send Check message to query the price
        self.requireInitialized();
        require(msg.quoteIndex == 0 && msg.quoteIndex == 1, "quoteIndex must be either 0 or 1");
        let ctx: Context = context();
        let remain: Int = (((ctx.value - STORAGE_FEE) - ctx.readForwardFee()) - CHECK_FEE);
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

    receive(msg: Chronoshift){
        self.requireInitialized();
        self.requireAlarm(msg.alarmIndex);
        let rewardAmount: Int = 0;
        if (msg.remainScale > 0) {
            rewardAmount = self.sync(msg.createdAt, msg.baseAssetPrice);
        }
        let ctx: Context = context();
        // Transfer the remaining funds and rewards to the Watchmaker
        if (msg.remainQuoteAssetScale > 0) {
            let sendValue: Int = ((msg.extraBaseAssetAmount  - STORAGE_FEE) - ctx.readForwardFee() - REWARD_FEE) - REFUND_FEE - TRANSFER_FEE;
            // The remain quote token is calculated by the formula:
            send(SendParameters{
                    to: self.quoteAssetWallet,
                    value: (msg.remainBaseAssetScale * MIN_BASEASSET_TRESHOLD + sendValue ),
                    mode: SendPayGasSeparately,
                    body: JettonTransfer{
                        query_id: 0,
                        amount: msg.extraQuoteAssetAmount,
                        destination: msg.watchmaker,
                        response_destination: msg.watchmaker,
                        custom_payload: null,
                        forward_ton_amount: 0,
                        forward_payload: emptySlice()
                    }.toCell()
                }
            );
        } else if (msg.remainBaseAssetScale > 0) {
            //  Refund TON
            let standardRefundAmount: Int =
                (((msg.extraBaseAssetAmount - STORAGE_FEE) - ctx.readForwardFee()) - REFUND_FEE - REWARD_FEE);
            send(SendParameters{
                    to: msg.watchmaker,
                    value: (msg.remainBaseAssetScale * MIN_BASEASSET_TRESHOLD + standardRefundAmount),
                    mode: 0,
                    body: "SlickBack".asComment()
                }
            );
        }
        if (rewardAmount > 0) {
            send(SendParameters{
                    to: myAddress(),
                    value: REWARD_FEE,
                    mode: SendPayGasSeparately,
                    body: JettonMint{
                        origin: myAddress(),
                        receiver: msg.watchmaker,
                        amount: rewardAmount,
                        custom_payload: null,
                        forward_ton_amount: 0,
                        forward_payload: emptySlice()
                    }.toCell()
                }
            );
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

    get fun getAlarmAddress(index: Int): Address {
        let initCode: StateInit = self._calculateAlarmInit(index);
        return contractAddress(initCode);
    }

    get fun TotalAmount(): Int {
        return self.totalAlarms;
    }

    get fun getLatestBaseAssetPrice(): Int {
        return self.latestBaseAssetPrice;
    }

    get fun getMyBalance(): Int {
        return myBalance();
    }

    get fun getOracleData(): OracleMetadata {
        return OracleMetadata {
            base_asset_address: self.baseAsset,
            quote_asset_address: self.quoteAsset,
            base_asset_decimals: 9,
            quote_asset_decimals: 6,
            min_base_asset_threshold: MIN_BASEASSET_TRESHOLD,
            base_asset_wallet_address: self.baseAssetWallet,
            quote_asset_wallet_address: self.quoteAssetWallet,
            is_initialized: self.is_initialized,
            latestBaseAssetPrice: self.latestBaseAssetPrice,
            latestTimestamp: self.latestTimestamp,
            totalAlarms: self.totalAlarms
        };
    }
}
