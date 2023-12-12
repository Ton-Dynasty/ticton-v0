import "@stdlib/deploy";
import "./library.tact";
import "./packages/math/float.fc";

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

message Initialize {
    baseAssetWallet: Address; // e.g. jetton wallet address for TON, which is 0
    quoteAssetWallet: Address; // e.g. jetton wallet address for USDT
}
message Tick {
    expireAt: Int as uint256; // If now() is larger than expireAt, then return the funds back to the Watchmaker if value is enough to pay the gas
    baseAssetPrice: Int as uint256; // baseAsset price relative to quoteAsset
}
message Tock {
    scale: Int as uint32;
    createdAt: Int;
    watchmaker: Address;
    baseAssetPrice: Int; // baseAsset price relative to quoteAsset (e.g. baseAssetPrice=2.5 means 1 TON = 2.5 USDT)
}
message Wind {
    alarmIndex: Int as uint256; // the interacted alarm index
    buyNum: Int as uint32; // how many scale to buy
    side: Int as uint8; // 0 for baseAsset, 1 for quoteAsset
}
message Reset {
    sender: Address;
    buyNum: Int; // The number of scales to buy
    side: Int; // 0 for baseAsset, 1 for quoteAsset
    quoteAssetAmount: Int; // The amount of quoteAsset oracle received
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
}
message Chime {
    alarmIndex: Int;
    timeKeeper: Address;
    createdAt: Int;
    baseAssetPrice: Int as uint256;
    remainScale: Int;
    newScale: Int;
    refundBaseAssetAmount: Int;
    refundQuoteAssetAmount: Int;
}
message(0x7362d09c) JettonTransferNotification {
    query_id: Int as uint64; // arbitrary request number
    amount: Int as coins; // amount of jettons to transfer
    sender: Address; // address of the sender of the jettons
    forward_payload: Slice as remaining; // optional custom payload
}
message(0x0f8a7ea5) JettonTransfer {
    query_id: Int as uint64; // arbitrary request number
    amount: Int as coins; // amount of jettons to transfer
    destination: Address; // address of the new owner of the jettons
    response_destination: Address; // address where to send a response with confirmation of a successful transfer and the rest of the incoming message Toncoins.
    custom_payload: Cell?; // optional custom payload
    forward_ton_amount: Int as coins; // the amount of nanotons to be sent to the destination address.
    forward_payload: Slice as remaining; // optional custom data that should be sent to the destination address.
}
const BASEASSET_DECIMALS: Int = 1000000000;
const QUOTEASSET_DECIMALS: Int = 100000;
const DEPLOY_FEE: Int = ton("0.1");
const STORAGE_FEE: Int = ton("0.007");
const CHECK_FEE: Int = ton("0.001");
const MIN_BASEASSET_TRESHOLD: Int = ton("1"); // 1 ton
const TIMEPACE: Int = 60; // 1 minutes

contract Alarm with Initializable {
    index: Int = 0;
    createdAt: Int = 0;
    watchmaker: Address;
    oracleAddress: Address;
    baseAssetScale: Int = 0;
    quoteAssetScale: Int = 0;
    remainScale: Int = 0;
    baseAssetPrice: Int = 0;
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
        self.baseAssetScale = msg.scale; // 1
        self.quoteAssetScale = msg.scale; // 1
        self.remainScale = msg.scale; // 1
        self.baseAssetPrice = msg.baseAssetPrice; // 3

        // Return the remaining funds back to the Watchmaker
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
        require(self.remainScale >= msg.buyNum, "Not enough scale to buy"); // MODIFIED: >= , and if this requirement is not satisfied, the jetton doesn't return back to the timekeeper
        let failed: Bool = false;
        let refundBaseAssetAmount: Int = 0; // 0 means return as much as possible
        let refundQuoteAssetAmount: Int = 0;
        let baseAssetPrice: Int = 0;
        if (msg.side == 0) {
            if (self.baseAssetScale < msg.buyNum) {
                failed = true;
            } else {
                // TimeKeeper take baseAsset away, so decrease baseAssetScale and increase quoteAssetScale
                self.baseAssetScale = (self.baseAssetScale - msg.buyNum); // TODO: Check overflow
                self.quoteAssetScale = (self.quoteAssetScale + msg.buyNum);
                self.remainScale = (self.remainScale - msg.buyNum); // TODO: Check overflow
            }
        } else {
            if (self.quoteAssetScale < msg.buyNum) {
                failed = true;
            } else {
                // TimeKeeper take quoteAsset away, so increase baseAssetScale and decrease quoteAssetScale
                self.baseAssetScale = (self.baseAssetScale + msg.buyNum); // TODO: Check overflow
                self.quoteAssetScale = (self.quoteAssetScale - msg.buyNum);
                self.remainScale = (self.remainScale - msg.buyNum); // TODO: Check overflow
            }
        }
        if (failed) {
            // Return all funds back to the TimeKeeper
            refundQuoteAssetAmount = msg.quoteAssetAmount;
        } else if (self.remainScale > 0 && now() > (self.createdAt + TIMEPACE)) {
            // send Chime message to the Oracle to update the price
            baseAssetPrice = self.baseAssetPrice;
        }
        send(SendParameters{
                to: ctx.sender,
                value: (ctx.value - ton("0.02")), // MODEFIED: - ton("0.02")
                mode: SendIgnoreErrors,
                body: Chime{
                    alarmIndex: self.index,
                    timeKeeper: msg.sender,
                    baseAssetPrice: baseAssetPrice,
                    createdAt: self.createdAt,
                    remainScale: self.remainScale,
                    newScale: msg.buyNum << 1,
                    refundQuoteAssetAmount: refundQuoteAssetAmount,
                    refundBaseAssetAmount: refundBaseAssetAmount
                }.toCell()
            }
        );
    }

    receive(msg: Mute){
        // TODO: When a Watchmaker wishes to mute an alarm
        // the alarm should reset the owner, then send Chronoshift message to the Watchmaker
        // Meanwhile, the oracle should receive a Sync message to update the price if the scale is not 0
        require(sender() == self.oracleAddress, "Only oracle can mute an alarm");
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
                    remainQuoteAssetScale: self.quoteAssetScale
                }.toCell()
            }
        );
    }

    // Get Methods
    get fun getWatchmaker(): Address {
        return self.watchmaker;
    }

    get fun getBaseAssetScale(): Int {
        return self.baseAssetScale;
    }

    get fun getQuoteAssetScale(): Int {
        return self.quoteAssetScale;
    }

    get fun getRemainScale(): Int {
        return self.remainScale;
    }

    get fun getBaseAssetPrice(): Int {
        return self.baseAssetPrice;
    }
}

contract OracleV0 with Deployable, Initializable {
    // deploy
    manager: Address;
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
    init(baseAsset: Address, quoteAsset: Address){
        self.manager = sender();
        self.is_initialized = false;
        self.baseAsset = baseAsset;
        self.quoteAsset = quoteAsset;
        self.baseAssetWallet = newAddress(0, 0);
        self.quoteAssetWallet = newAddress(0, 0);
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

    receive(msg: Initialize){
        require(self.is_initialized == false, "Already initialized");
        require(sender() == self.manager, "Only manager can initialize"); //Can not pass, cause manager is not set yet
        require(msg.baseAssetWallet == newAddress(0, 0), "Only support TON as baseAsset");
        self.manager = sender();
        self.is_initialized = true;
        self.baseAssetWallet = msg.baseAssetWallet;
        self.quoteAssetWallet = msg.quoteAssetWallet;
    }

    receive(msg: JettonTransferNotification){
        let ctx: Context = context();
        if (self.is_initialized == false) {
            // Return jetton back if gas is enough
            send(SendParameters{to: ctx.sender, value: ((ctx.value - ctx.readForwardFee()) - STORAGE_FEE), mode: 0});
            return ;
        }
        require(ctx.sender == self.quoteAssetWallet, "Only oracle quoteAsset wallet can send notification to oracle");
        let payload: Slice = msg.forward_payload;
        let ref: Cell = payload.loadRef();
        let sc: Slice = ref.beginParse();
        let opCode: Int = sc.loadUint(8); // 0 means Tick, 1 means Wind
        if (opCode == 0) {
            // Method: Tick
            let currentTimestamp: Int = now();
            let expireAt: Int = sc.loadUint(256);
            let baseAssetPrice: Int = sc.loadUint(256); // The first 156 bits is integer part, the last 100 bits is float part
            if (currentTimestamp > expireAt) {
                // Return jetton back if gas is enough
                if (self.baseAssetWallet != newAddress(0, 0)) {
                    // TODO: if base asset is not TON, return the base asset back to the Watchmaker
                    dump("Not implemented yet");
                }
                if (self.quoteAssetWallet != newAddress(0, 0)) {
                    let value: Int = ((ctx.value - ctx.readForwardFee()) - STORAGE_FEE);
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
            let needBaseAssetAmount: Int = msg.amount.float().muldiv(BASEASSET_DECIMALS, baseAssetPrice);
            require(needBaseAssetAmount > MIN_BASEASSET_TRESHOLD, "baseAssetAmount is too small");
            require(ctx.value > (needBaseAssetAmount + 2 * (ctx.readForwardFee() + STORAGE_FEE)),
                "Insufficient funds to pay for the gas"
            );
            // TODO: If the requirement above is not satisfied, return the funds and jetton back to the Watchmaker
            nativeReserve(needBaseAssetAmount, 0);
            // MODIFIED: origin is value:0 mode: SendPayGasSeparately
            let sendBackAmount: Int = ((ctx.value - needBaseAssetAmount) - 2 * (ctx.readForwardFee() + STORAGE_FEE));
            // Open a new alarm
            let initCode: StateInit = self._calculateAlarmInit(self.totalAlarms);
            send(SendParameters{
                    to: contractAddress(initCode),
                    value: sendBackAmount,
                    mode: SendIgnoreErrors,
                    body: Tock{
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
            let side: Int = sc.loadUint(1);
            // Don't we need to add new baseprice? right now the alarm that timekeep build its baseprice is 0
            require(alarmIndex < self.totalAlarms, "alarmIndex out of range");
            require(side == 0 || side == 1, "side must be either 0 or 1");
            send(SendParameters{
                    to: contractAddress(self._calculateAlarmInit(alarmIndex)),
                    value: (ctx.value - STORAGE_FEE),
                    mode: 0,
                    body: Reset{sender: msg.sender, buyNum: buyNum, side: side, quoteAssetAmount: msg.amount}.toCell() // MODIFIED: sender is msg.sender, not ctx.sender
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
                body: Mute{queryID: msg.queryID}.toCell()
            }
        );
    }

    receive(msg: Chime){
        // Receive Chime message from Alarm contract
        self.requireInitialized();
        self.requireAlarm(msg.alarmIndex);
        if (msg.remainScale > 0) {
            self.sync(msg.createdAt, msg.baseAssetPrice);
        }
        // Deploy a new alarm contract
        let initCode: StateInit = self._calculateAlarmInit(self.totalAlarms);
        send(SendParameters{
                to: contractAddress(initCode),
                value: ton("0.02"), // MODIFIED: it has to be at least 0.02 ton to initialize a new alarm
                mode: 0,
                body: Tock{
                    createdAt: now(),
                    scale: msg.newScale,
                    watchmaker: msg.timeKeeper,
                    baseAssetPrice: msg.baseAssetPrice
                }.toCell(),
                code: initCode.code,
                data: initCode.data
            }
        );
        self.totalAlarms = (self.totalAlarms + 1); // MODIFIED: Miss to add totalAlarms
        // Transfer the remaining funds or profits to the TimeKeeper
        let ctx: Context = context();
        if (msg.refundQuoteAssetAmount > 0) {
            // Send Jetton Transfer message to refund
            send(SendParameters{
                    to: self.quoteAssetWallet,
                    value: msg.refundBaseAssetAmount,
                    mode: SendRemainingValue,
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
        if (msg.refundBaseAssetAmount > 0) {
            send(SendParameters{
                    to: msg.timeKeeper,
                    value: msg.refundBaseAssetAmount,
                    mode: 0,
                    body: "SlickBack".asComment()
                }
            );
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
        if (msg.remainScale > 0) {
            self.sync(msg.createdAt, msg.baseAssetPrice);
        }
        // Transfer the remaining funds and rewards to the Watchmaker
        if (msg.remainQuoteAssetScale > 0) {
            // The remain quote token is calculated by the formula:
            send(SendParameters{
                    to: self.quoteAssetWallet,
                    value: msg.remainQuoteAssetScale,
                    mode: SendPayGasSeparately,
                    body: JettonTransfer{
                        query_id: 0,
                        amount: int(msg.baseAssetPrice.mul(msg.remainQuoteAssetScale)),
                        destination: msg.watchmaker,
                        response_destination: msg.watchmaker,
                        custom_payload: null,
                        forward_ton_amount: 0,
                        forward_payload: emptySlice()
                    }.toCell()
                }
            );
            return ;
        } else if (msg.remainBaseAssetScale > 0) {
            //  Refund TON
            send(SendParameters{
                    to: self.quoteAssetWallet,
                    value: msg.remainBaseAssetScale,
                    mode: SendPayGasSeparately,
                    body: "SlickBack".asComment()
                }
            );
        }
    }

    inline fun sync(timestamp: Int, baseAssetPrice: Int) {
        // TODO: Calculate the weighted average of the baseAssetPrice
        // For testing purpose, we just use (9*old + new) / 10
        // Actual formula:
        // d = (new timestamp - old timestamp) / TIMEPACE
        // w = 0.9 * {1 - [1 / (1 - d^2)]^2}
        if (timestamp <= self.latestTimestamp) {
            return ;
        }
        if (self.latestTimestamp == 0) {
            self.latestTimestamp = timestamp;
            self.latestBaseAssetPrice = baseAssetPrice;
            return ;
        }
        self.latestBaseAssetPrice = (9 * self.latestBaseAssetPrice + baseAssetPrice) / 10;
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
}