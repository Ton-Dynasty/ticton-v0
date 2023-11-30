import "@stdlib/deploy";
import "./library.tact";
message Initialize {
    baseAssetWallet: Address; // e.g. jetton wallet address for TON, which is 0
    quoteAssetWallet: Address; // e.g. jetton wallet address for USDT
}
message Tick {
    validBefore: Int as uint256; // If now() is larger than validBefore, then return the funds back to the Watchmaker if value is enough to pay the gas
    baseAssetPrice: Int as uint256; // baseAsset price relative to quoteAsset
    scale: Int as uint32; // Scale is a multiplier of the MIN_BASEASSET_TRESHOLD, valid range is [1, 100]
}
message Tock {
    scale: Int as uint32;
    createdAt: Int;
    watchmaker: Address;
    baseAssetPrice: Int; // baseAsset price relative to quoteAsset (e.g. baseAssetPrice=2.5 means 1 TON = 2.5 USDT)
}
message Wind {
    alarmIndex: Int;
    buyNum: Int;
    quoteIndex: Int; // 0 for baseAsset, 1 for quoteAsset
}
message Reset {
    buyNum: Int; // The number of scales to buy
    quoteIndex: Int; // 0 for baseAsset, 1 for quoteAsset
}
message Sync {
    baseAssetAmount: Int;
    baseAssetScale: Int;
    quoteAssetAmount: Int;
    quoteAssetScale: Int;
    timestamp: Int;
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
    timestamp: Int;
}
message Chime {
    timeKeeper: Address;
    timestamp: Int;
}
message(0x7362d09c) JettonTransferNotification {
    query_id: Int as uint64; // arbitrary request number
    amount: Int as coins; // amount of jettons to transfer
    sender: Address; // address of the sender of the jettons
    forward_payload: Slice as remaining; // optional custom payload
}
const MIN_TON_FOR_STORAGE: Int = ton("0.001");
const MAX_SCALE: Int = 256;
const MIN_BASEASSET_TRESHOLD: Int = ton("1"); // 1 ton
const TELL_TIME_INTERVAL: Int = 60; // 1 minutes

contract Alarm with Initializable, FixedPoint156x100 {
    index: Int = 0;
    createdAt: Int = 0;
    watchmaker: Address;
    oracleAddress: Address;
    baseAssetScale: Int = 0;
    quoteAssetScale: Int = 0;
    remainScale: Int = 0;
    init(index: Int){
        self.index = index;
        self.oracleAddress = newAddress(0, 0);
        self.watchmaker = newAddress(0, 0);
    }

    override inline fun requireInitialized() {
        require(self.oracleAddress != newAddress(0, 0), "Not initialized");
    }

    override inline fun requireNotInitialized() {
        require(self.oracleAddress == newAddress(0, 0), "Already initialized");
    }

    inline fun requireOracle(sender: Address) {
        require(sender == self.oracleAddress, "Only oracle can call this function");
    }

    receive(msg: Tock){
        // TODO: Receive a Tock message from the Oracle, should initialize the parameters
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
        // TODO: When receiving Reset message, first validate the baseAsset and quoteAsset balance
        // Then send Sync message to the Oracle to update the price
        // Steps:
        // 1. Check time is smaller than (createdAt + validLifetime)
        // 2. increase/decrease baseAssetScale and quoteAssetScale, depends on the buyNum and quoteIndex (0 to decrease baseAssetScale and increase quoteAssetScale)
        // 3. Send Sync message to the Oracle
    }

    receive(msg: Mute){
        // TODO: When a Watchmaker wishes to mute an alarm
        // the alarm should reset the owner, then send Chronoshift message to the Watchmaker
        // Meanwhile, the oracle should receive a Sync message to update the price if the scale is not 0
        require(sender() == self.oracleAddress, "Only oracle can mute an alarm");
    }
}

contract OracleV0 with Deployable, Initializable, FixedPoint156x100 {
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
    lastPrice0: Int = 0; // latest price of baseAsset
    lastTimestamp: Int = 0;
    init(baseAsset: Address, quoteAsset: Address){
        self.manager = sender();
        self.is_initialized = false;
        self.baseAsset = baseAsset;
        self.quoteAsset = quoteAsset;
        self.baseAssetWallet = newAddress(0, 0);
        self.quoteAssetWallet = newAddress(0, 0);
    }

    override inline fun requireInitialized() {
        require(self.is_initialized == true, "Not initialized");
    }

    override inline fun requireNotInitialized() {
        require(self.is_initialized == false, "Already initialized");
    }

    receive(msg: Initialize){
        require(self.is_initialized == false, "Already initialized");
        require(sender() == self.manager, "Only manager can initialize");
        require(msg.baseAssetWallet == newAddress(0, 0), "Only support TON as baseAsset");
        self.is_initialized = true;
        self.baseAssetWallet = msg.baseAssetWallet;
        self.quoteAssetWallet = msg.quoteAssetWallet;
    }

    receive(msg: JettonTransferNotification){
        let ctx: Context = context();
        if (self.is_initialized == false) {
            // TODO: Return jetton back if gas is enough
            return ;
        }
        require(ctx.sender == self.quoteAssetWallet, "Only oracle quoteAsset wallet can send notification to oracle");
        let sc: Slice = msg.forward_payload;
        let opCode: Int = sc.loadUint(8); // 0 means Tick, 1 means Wind
        if (opCode == 0) {
            // Method: Tick
            let currentTimestamp: Int = now();
            let validBefore: Int = sc.loadUint(256);
            let baseAssetPrice: Int = sc.loadUint(256); // The first 156 bits is integer part, the last 100 bits is float part
            let scale: Int = sc.loadUint(32);
            if (validBefore > currentTimestamp || scale != 1) {
                // TODO: Return jetton back if gas is enough
                return ;
            }
            // Preserve the baseAssetAmount
            let needBaseAssetAmount: Int = self.encode(msg.amount) * baseAssetPrice;
            require(needBaseAssetAmount > MIN_BASEASSET_TRESHOLD, "baseAssetAmount is too small");
            require(ctx.value > (needBaseAssetAmount + 2 * (ctx.readForwardFee() + MIN_TON_FOR_STORAGE)),
                "Insufficient funds to pay for the gas"
            );
            nativeReserve(needBaseAssetAmount, 0);
            // Open a new alarm
            let initCode: StateInit = self._calculateAlarmInit(self.totalAlarms);
            send(SendParameters{
                    to: contractAddress(initCode),
                    value: 0,
                    bounce: true,
                    mode: SendPayGasSeparately,
                    body: Tock{
                        scale: scale,
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
            self.wind();
            return ;
        }
    }

    receive(msg: Sync){
        self.requireInitialized();
        self.sync();
    }

    receive(msg: Ring){
        self.requireInitialized();
        // TODO: Watchmaker sends Ring message to Mute a specific alarm
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
        self.requireInitialized();
        self.sync();
    }

    receive(msg: Check){
        self.requireInitialized();
        // TODO: Protocols send Check message to query the price
        require(msg.quoteIndex == 0 && msg.quoteIndex == 1, "quoteIndex must be either 0 or 1");
        if (msg.quoteIndex == 0) {
            send(SendParameters{
                    to: sender(),
                    value: 0,
                    mode: SendRemainingValue,
                    body: Announce{
                        queryID: msg.queryID,
                        quoteAsset: self.baseAsset,
                        timestamp: self.lastTimestamp,
                        price: self.lastPrice0
                    }.toCell()
                }
            );
            return ;
        }
        if (msg.quoteIndex == 1) {
            // send(SendParameters{
            //         to: sender(),
            //         value: 0,
            //         mode: SendRemainingValue,
            //         body: Announce{
            //             queryID: msg.queryID,
            //             quoteAsset: self.quoteAsset,
            //             timestamp: self.lastTimestamp,
            //             price: self.lastPrice1
            //         }.toCell()
            //     }
            // );
            return ;
        }
    }

    receive(msg: Chronoshift){
        self.sync();

        // TODO: Transfer the remaining funds and rewards to the Watchmaker
    }

    inline fun wind() {}

    inline fun sync() {
        // TODO: update lastPrice0, lastPrice1, lastTimestamp by formula
    }

    inline fun _calculateAlarmInit(index: Int): StateInit {
        return initOf Alarm(index);
    }

    get fun getAlarmAddress(index: Int): Address {
        let initCode: StateInit = self._calculateAlarmInit(index);
        return contractAddress(initCode);
    }

    get fun TotalAmount(): Int {
        return self.totalAlarms;
    }
}