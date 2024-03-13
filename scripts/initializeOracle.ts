import { toNano, Address, beginCell, openContract } from 'ton-core';
import { OracleV0 } from '../wrappers/Oracle';
import { NetworkProvider } from '@ton-community/blueprint';
import { buildJettonContent } from '../utils/ton-tep64';
import { JettonMaster } from 'ton';

export async function run(provider: NetworkProvider) {
    // null address represents ton coin
    const nullAddress: Address = new Address(0, Buffer.alloc(32));

    // mock jUSDT address (EQBqSpvo4S87mX9tjHaG4zhYZeORhVhMapBJpnMZ64jhrEQK)
    const { address: quoteAsset } = Address.parseFriendly('EQBqSpvo4S87mX9tjHaG4zhYZeORhVhMapBJpnMZ64jhrEQK');

    // build jetton content for reward token
    const rewardTokenJettonContent = buildJettonContent({
        name: 'TicTon',
        description: 'Reward token for Tic Ton Oracle',
        symbol: 'TIC',
        image: 'https://github.com/Ton-Dynasty/ticton-v0/blob/chore/add-comment/image/ticton.jpg?raw=true',
    });

    // Initialize oracle costant
    const oracle = provider.open(await OracleV0.fromInit(nullAddress, quoteAsset));

    // Deploy oracle
    await oracle.send(
        provider.sender(),
        {
            value: toNano('0.1'),
        },
        {
            $$type: 'Deploy',
            queryId: 0n,
        }
    );

    // wait for deploy
    await provider.waitForDeploy(oracle.address);

    // quote asset jetton master
    const quoteJettonMaster = provider.open(JettonMaster.create(quoteAsset));
    const oracleUSDTWallet = await quoteJettonMaster.getWalletAddress(oracle.address);

    // send initialize message to oracle
    // initialize base asset jetton wallet and quote asset jetton wallet
    // and reward token jetton content
    await oracle.send(
        provider.sender(),
        {
            value: toNano('0.1'),
        },
        {
            $$type: 'Initialize',
            baseAssetWallet: nullAddress,
            quoteAssetWallet: oracleUSDTWallet,
            rewardJettonContent: rewardTokenJettonContent,
        }
    );

    const urlPrefix = `https://${provider.network() === 'testnet' ? 'testnet.' : ''}tonviewer.com`;
    const url = `${urlPrefix}/${oracle.address.toString()}`;
    console.log('Oracle initialized, please check the address:', url);
}
