import Decimal from 'decimal.js';

/**
 * float converts a number to a fixed point representation.
 * @param value the value to convert
 * @param precision the precision of the fixed point representation, defaults to 2^64
 * @returns the fixed point representation
 */
export const float = (value: number | string | Decimal, precision: number = 64): Decimal => {
    return new Decimal(value).times(Decimal.pow(2, precision));
};

export const int = (value: Decimal): Decimal => {
    return new Decimal(value).divToInt(Decimal.pow(2, 64));
};

export const toToken = (value: number | string | Decimal, decimals: number): Decimal => {
    return new Decimal(value).times(Decimal.pow(10, decimals));
};
