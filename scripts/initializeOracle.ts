import { toNano, Address, beginCell } from 'ton-core';
import { OracleV0 } from '../wrappers/Oracle';
import { NetworkProvider } from '@ton-community/blueprint';

export async function run(provider: NetworkProvider) {
    // null address represents ton coin
    const nullAddress: Address = new Address(0, Buffer.alloc(32));
    const { address: quoteAsset } = Address.parseFriendly('EQBqSpvo4S87mX9tjHaG4zhYZeORhVhMapBJpnMZ64jhrEQK');
    const oracle = provider.open(await OracleV0.fromInit(nullAddress, quoteAsset));

    const { address: oracleUSDTWallet } = Address.parseFriendly('kQBbiTLsPrFk2SPVGE6A1CU5AMZ9g5vhndGxtS9GiXPLu3ow');

    await oracle.send(
        provider.sender(),
        {
            value: toNano('0.1'),
        },
        {
            $$type: 'Initialize',
            baseAssetWallet: nullAddress,
            quoteAssetWallet: oracleUSDTWallet,
            rewardJettonContent: beginCell().endCell(),
        }
    );

    await provider.waitForDeploy(oracle.address);
    // run methods on `oracle`
}
