import { toNano, Address } from 'ton-core';
import { OracleV0 } from '../wrappers/Oracle';
import { NetworkProvider } from '@ton-community/blueprint';

export async function run(provider: NetworkProvider) {
    // null address represents ton coin
    const nullAddress: Address = new Address(0, Buffer.alloc(32));
    const quoteAsset: Address = nullAddress;
    const oracle = provider.open(await OracleV0.fromInit(nullAddress, quoteAsset));

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

    await provider.waitForDeploy(oracle.address);
    // run methods on `oracle`
}
