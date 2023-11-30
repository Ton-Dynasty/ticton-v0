trait Initializable {
    abstract inline fun requireInitialized();

    abstract inline fun requireNotInitialized();
}
trait FixedPoint156x100 {
    // Use 156 bits to store the integer part (46 digits), and 100 bits to store the float part (30 digits)
    // Range: [0, 2^156-1]
    // Precision: 1 / 2^100
    virtual const FP100: Int = pow(2, 100);

    virtual inline fun encode(x: Int): Int {
        return x * self.FP100;
    }

    virtual inline fun div(encodeX: Int, y: Int): Int {
        return encodeX / y;
    }
}