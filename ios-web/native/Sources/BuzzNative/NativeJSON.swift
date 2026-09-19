import Foundation
import CoreFoundation

/// JSONSerialization bridges true to NSNumber(1); protocol integers must not.
func nativeInteger(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite,
          number.doubleValue.rounded() == number.doubleValue,
          abs(number.doubleValue) <= 9_007_199_254_740_991 else { return nil }
    return number.intValue
}
