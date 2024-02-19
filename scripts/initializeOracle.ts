import { toNano, Address, beginCell } from 'ton-core';
import { OracleV0 } from '../wrappers/Oracle';
import { NetworkProvider } from '@ton-community/blueprint';
import { buildJettonContent } from '../utils/ton-tep64';

export async function run(provider: NetworkProvider) {
    // null address represents ton coin
    const nullAddress: Address = new Address(0, Buffer.alloc(32));
    // jUSDC: EQCgGCY-rAxD89c4vQzGUZAiCbwbQgFXBJJJNTdJsbZdKVFG
    // jUSDT: EQBqSpvo4S87mX9tjHaG4zhYZeORhVhMapBJpnMZ64jhrEQK
    const { address: quoteAsset } = Address.parseFriendly('EQBqSpvo4S87mX9tjHaG4zhYZeORhVhMapBJpnMZ64jhrEQK');
    const jettonContent = buildJettonContent({
        name: 'TonDynasty',
        description: 'TonDynasty Co-Founder Certificate - Tact',
        symbol: 'TDT',
        image: 'https://avatars.githubusercontent.com/u/144251015?s=400&u=a25dfca41bdc6467d9783f5225c93f60e1513630&v=4',
    });
    const oracle = provider.open(await OracleV0.fromInit(nullAddress, quoteAsset, jettonContent));

    // jUSDC Quote Asset Wallet: kQDOjMnwOdaFiL8vCHDrACSWDbGOLQ0GZ-6Dyvpvbpw7vRo1
    // 0QAErpB62VTj5l2AmnTppE2vrO1LS3fs3NmNisJGRcukpoqr
    const { address: oracleUSDTWallet } = Address.parseFriendly('0QAErpB62VTj5l2AmnTppE2vrO1LS3fs3NmNisJGRcukpoqr');

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
