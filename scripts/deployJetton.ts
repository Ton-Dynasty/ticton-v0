import { toNano } from 'ton-core';
import { Jetton } from '../wrappers/Jetton';
import { NetworkProvider } from '@ton-community/blueprint';

export async function run(provider: NetworkProvider) {
    const jetton = provider.open(await Jetton.fromInit());

    await jetton.send(
        provider.sender(),
        {
            value: toNano('0.05'),
        },
        {
            $$type: 'Deploy',
            queryId: 0n,
        }
    );

    await provider.waitForDeploy(jetton.address);

    // run methods on `jetton`
}
