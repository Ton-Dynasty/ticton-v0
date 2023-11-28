import "@stdlib/deploy";
message Tick {
}
message Tock {
    creator: Address;
}
message Wind {
}
message Reset {
}
message Sync {
}
message Ring {
}
message Mute {
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
    query_id: Int as uint64;                // arbitrary request number
    amount: Int as coins;                   // amount of jettons to transfer
    sender: Address;                        // address of the sender of the jettons
    forward_payload: Slice as remaining;    // optional custom payload
}

message OracleToken1Wallet {
    oracleToken1Address: Address;
}
contract Alarm {
    index: Int = 0;
    owner: Address? = null;
    init(index: Int){
        self.index = index;
    }

    receive(msg: Tock){
        require(self.owner == null, "Alarm already claimed");
        self.owner = msg.creator;
        // TODO: You know what to do
    }

    receive(msg: Reset){
        // TODO: When receiving Reset message, first validate the token0 and token1 balance
        // Then send Sync message to the Oracle to update the price
    }

    receive(msg: Mute){
        // TODO: When a Watchmaker wishes to mute an alarm
        // the alarm should reset the owner, then send Chronoshift message to the Watchmaker
        // Meanwhile, the oracle should receive a Sync message to update the price if the scale is not 0
    }
}

contract OracleV0 with Deployable {
    token0: Address; // ton
    token1: Address; // usdt
    totalAlarms: Int = 0;
    lastPrice0: Int = 0;
    lastPrice1: Int = 0;
    lastTimestamp: Int = 0;
    token0Amount: Int = 0;
    token1Amount: Int = 0;
    oracleToken1Address: Address? = null;
    init(token0: Address, token1: Address){
        self.token0 = token0;
        self.token1 = token1;
    }

    // Set Oracle Token1 Wallet Address, so that oracle can make sure it received token1 from the wallet
    receive(msg: OracleToken1Wallet){
        if(self.oracleToken1Address == null){
            self.oracleToken1Address = msg.oracleToken1Address;
        }
    }

    receive(msg: JettonTransferNotification){
        // TODO: Tick
        // Create an alarm by sending Tock message

        let ctx: Context = context();
        require(ctx.sender == self.oracleToken1Address, "Only oracle token1 wallet can send notification to oracle");
        self.token0Amount = self.token0Amount + ctx.value;
        self.token1Amount = self.token1Amount + msg.amount;

        // TODO: Wind
        // TimeKeepers send Reset message to the alarm, reply with Sync message
    }

    receive(msg: Sync){
        // TODO: update lastPrice0, lastPrice1, lastTimestamp by formula
    }

    receive(msg: Ring){
        // TODO: Watchmaker sends Ring message to Mute a specific alarm
    }

    receive(msg: Check){
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
            send(SendParameters{
                    to: sender(),
                    value: 0,
                    mode: SendRemainingValue,
                    body: Announce{
                        queryID: msg.queryID,
                        quoteAsset: self.token1,
                        timestamp: self.lastTimestamp,
                        price: self.lastPrice1
                    }.toCell()
                }
            );
            return ;
        }
    }

    inline fun calculate_jetton_wallet_init(index: Int): StateInit {
        return initOf Alarm(index);
    }

    inline fun getAlarm(index: Int): Address {
        let initCode: StateInit = self.calculate_jetton_wallet_init(owner_address);
        return contractAddress(initCode);
    }

    get fun TotalAmount(): Int {
        return self.totalAlarms;
    }
}