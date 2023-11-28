import "@stdlib/deploy";
message Initialize {
    token0Wallet: Address;
    token1Wallet: Address;
    token0Threshold: Int; // The minimum token0 to toc an alarm
}
message Tick {
}
message Tock {
    watchmaker: Address;
    token1Amount: Int;
    token0Threshold: Int;
}
message Wind {
}
message Reset {
}
message Sync {
    token0Value: Int;
    token0Scale: Int;
    token1Value: Int;
    token1Scale: Int;
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
    quoteIndex: Int; // 0 for token0, 1 for token1
}
message Announce {
    queryID: Int;
    quoteAsset: Address;
    timestamp: Int;
    price: Int;
}
message Chronoshift {
}
message(0x7362d09c) JettonTransferNotification {
    query_id: Int as uint64; // arbitrary request number
    amount: Int as coins; // amount of jettons to transfer
    sender: Address; // address of the sender of the jettons
    forward_payload: Slice as remaining; // optional custom payload
}
message OracleToken1Wallet {
    oracleToken1Address: Address;
}

contract Alarm {
    index: Int = 0;
    oracleAddress: Address? = null;
    token0Threshold: Int = 0;
    token1Amount: Int = 0;
    token0Scale: Int = 0;
    token1Scale: Int = 0;
    watchmaker: Address;
    init(index: Int, oracleAddress: Address){
        self.index = index;
        self.oracleAddress = oracleAddress;
        self.watchmaker = newAddress(0, 0);
    }

    receive(msg: Tock){
        require(self.oracleAddress == null, "Alarm already claimed");
        self.watchmaker = msg.watchmaker;
        // TODO: You know what to do
        self.token0Threshold = msg.token0Threshold;
        self.token1Amount = msg.token1Amount;
        self.watchmaker = msg.watchmaker;
    }

    receive(msg: Reset){
        // TODO: When receiving Reset message, first validate the token0 and token1 balance
        // Then send Sync message to the Oracle to update the price
    }

    receive(msg: Mute){
        // TODO: When a Watchmaker wishes to mute an alarm
        // the alarm should reset the owner, then send Chronoshift message to the Watchmaker
        // Meanwhile, the oracle should receive a Sync message to update the price if the scale is not 0
        require(sender() == self.oracleAddress, "Only oracle can mute an alarm");
    }
}

contract OracleV0 with Deployable {
    // deploy
    manager: Address;
    // initialize
    is_initialized: Bool;
    token0: Address; // ton
    token1: Address; // usdt
    token0Wallet: Address;
    token1Wallet: Address;
    token0Threshold: Int;
    // calculated
    totalAlarms: Int = 0;
    lastPrice0: Int = 0;
    lastTimestamp: Int = 0;
    init(token0: Address, token1: Address){
        self.manager = sender();
        self.is_initialized = false;
        self.token0 = token0;
        self.token1 = token1;
        self.token0Wallet = newAddress(0, 0);
        self.token1Wallet = newAddress(0, 0);
        self.token0Threshold = 0;
    }

    receive(msg: Initialize){
        require(self.is_initialized == false, "Already initialized");
        require(sender() == self.manager, "Only manager can initialize");
        self.is_initialized = true;
        self.token0Wallet = msg.token0Wallet;
        self.token1Wallet = msg.token1Wallet;
        self.token0Threshold = msg.token0Threshold;
    }

    receive(msg: JettonTransferNotification){
        if (self.is_initialized == false) {
            // TODO: Return jetton back if gas is enough
            return ;
        }
        let ctx: Context = context();
        require(ctx.sender == self.token1Wallet, "Only oracle token1 wallet can send notification to oracle");
        require(ctx.value > self.token0Threshold, "Insufficient fee");
        let tmpSlice: Slice = msg.forward_payload;
        let msgType: Int = tmpSlice.loadUint(8); // 0 means Tick, 1 means Wind
        let remainToken0Amount: Int = (ctx.value - self.token0Threshold); // TODO: ctx.value have to sub the operation fee
        let token1Amount: Int = msg.amount;
        if (msgType == 0) {
            // TODO: Tick
            // Create an alarm by sending Tock message
            // forward_payload: Slice;
            // Tick:
            //     msgType: Int
            //     creator: Address
            // Wind:
            //     msgType: Int
            //     alarmIndex: Int
            let watchmaker: Address = tmpSlice.loadAddress();
            let initCode: StateInit = self._calculateAlarmInit(self.totalAlarms);
            send(SendParameters{
                    to: contractAddress(initCode),
                    value: 0,
                    bounce: true,
                    mode: SendRemainingValue,
                    body: Tock{
                        watchmaker: watchmaker,
                        token1Amount: token1Amount,
                        token0Threshold: self.token0Threshold
                    }.toCell(),
                    code: initCode.code,
                    data: initCode.data
                }
            );
            self.totalAlarms = (self.totalAlarms + 1);
        }

        // TODO: Wind
        // TimeKeepers send Reset message to the alarm, reply with Sync message
    }

    receive(msg: Sync){
        require(self.is_initialized == true, "Not initialized");
        self.sync();
    }

    receive(msg: Ring){
        require(self.is_initialized == true, "Not initialized");
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

    receive(msg: Check){
        require(self.is_initialized == true, "Not initialized");
        // TODO: Protocols send Check message to query the price
        require(msg.quoteIndex == 0 && msg.quoteIndex == 1, "quoteIndex must be either 0 or 1");
        if (msg.quoteIndex == 0) {
            send(SendParameters{
                    to: sender(),
                    value: 0,
                    mode: SendRemainingValue,
                    body: Announce{
                        queryID: msg.queryID,
                        quoteAsset: self.token0,
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
            //             quoteAsset: self.token1,
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

    inline fun sync() {
        // TODO: update lastPrice0, lastPrice1, lastTimestamp by formula
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
}