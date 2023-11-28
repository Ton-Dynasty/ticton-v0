import "@stdlib/deploy";
message Tick {
}
message Tock {
}
message Wind {
}
message Set {
}
message Sync {
}
message Ring {
}
message Mute {
}
message Check {
}
message Announce {
}
message Chronoshift {
}
message TokenNotification {
}

contract Alarm {
    index: Int = 0;
    init(index: Int){
        self.index = index;
    }

    receive(msg: Tock){}

    receive(msg: Set){}

    receive(msg: Mute){}
}

contract OracleV0 with Deployable {
    token0: Address;
    token1: Address;
    totalAlarms: Int = 0;
    init(token0: Address, token1: Address){
        self.token0 = token0;
        self.token1 = token1;
    }

    receive(msg: TokenNotification){}

    receive(msg: Sync){}

    receive(msg: Ring){}

    receive(msg: Wind){}

    receive(msg: Check){}

    inline fun getAlarm(index: Int): Address {}

    get fun TotalAmount(): Int {
        return self.totalAlarms;
    }
}