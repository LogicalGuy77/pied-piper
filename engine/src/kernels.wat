;; Matmul kernels in WebAssembly SIMD (128-bit, 4 float32 lanes).
;; Compiled by `npm run build:wasm` into kernels-wasm.js.
;;
;; Both compute y[n, out] = x[n, in] @ W[out, in]^T, the same as matmul() in
;; kernels.js. Pointers are byte offsets into the imported memory. `in` must
;; be a multiple of 16. Each dot product is summed in four float32x4
;; accumulators, then lanes are added in a fixed order, so the result is the
;; same on every machine (no fused multiply-add, no relaxed SIMD).

(module
  (import "env" "memory" (memory 1))

  ;; float32 W: row o starts at w + o * in * 4.
  (func (export "matmul_f32")
    (param $x i32) (param $w i32) (param $y i32) (param $n i32) (param $in i32) (param $out i32)
    (local $o i32) (local $t i32) (local $i i32) (local $rowBytes i32)
    (local $wrow i32) (local $wp i32) (local $xp i32) (local $yp i32)
    (local $a0 v128) (local $a1 v128) (local $a2 v128) (local $a3 v128)
    (local.set $rowBytes (i32.shl (local.get $in) (i32.const 2)))
    (block $done_o (loop $next_o
      (br_if $done_o (i32.ge_u (local.get $o) (local.get $out)))
      (local.set $wrow (i32.add (local.get $w) (i32.mul (local.get $o) (local.get $rowBytes))))
      (local.set $t (i32.const 0))
      (block $done_t (loop $next_t
        (br_if $done_t (i32.ge_u (local.get $t) (local.get $n)))
        (local.set $wp (local.get $wrow))
        (local.set $xp (i32.add (local.get $x) (i32.mul (local.get $t) (local.get $rowBytes))))
        (local.set $a0 (v128.const i32x4 0 0 0 0))
        (local.set $a1 (v128.const i32x4 0 0 0 0))
        (local.set $a2 (v128.const i32x4 0 0 0 0))
        (local.set $a3 (v128.const i32x4 0 0 0 0))
        (local.set $i (i32.const 0))
        (block $done_i (loop $next_i
          (br_if $done_i (i32.ge_u (local.get $i) (local.get $in)))
          (local.set $a0 (f32x4.add (local.get $a0)
            (f32x4.mul (v128.load (local.get $wp)) (v128.load (local.get $xp)))))
          (local.set $a1 (f32x4.add (local.get $a1)
            (f32x4.mul (v128.load offset=16 (local.get $wp)) (v128.load offset=16 (local.get $xp)))))
          (local.set $a2 (f32x4.add (local.get $a2)
            (f32x4.mul (v128.load offset=32 (local.get $wp)) (v128.load offset=32 (local.get $xp)))))
          (local.set $a3 (f32x4.add (local.get $a3)
            (f32x4.mul (v128.load offset=48 (local.get $wp)) (v128.load offset=48 (local.get $xp)))))
          (local.set $wp (i32.add (local.get $wp) (i32.const 64)))
          (local.set $xp (i32.add (local.get $xp) (i32.const 64)))
          (local.set $i (i32.add (local.get $i) (i32.const 16)))
          (br $next_i)))
        (local.set $yp (i32.add (local.get $y)
          (i32.shl (i32.add (i32.mul (local.get $t) (local.get $out)) (local.get $o)) (i32.const 2))))
        (f32.store (local.get $yp)
          (call $hsum (f32x4.add (f32x4.add (local.get $a0) (local.get $a1))
                                 (f32x4.add (local.get $a2) (local.get $a3)))))
        (local.set $t (i32.add (local.get $t) (i32.const 1)))
        (br $next_t)))
      (local.set $o (i32.add (local.get $o) (i32.const 1)))
      (br $next_o))))

  ;; int8 W with one float32 scale per row: W[o][i] = q[o * in + i] * scale[o].
  ;; 16 int8 weights per step, widened to four float32x4 vectors.
  (func (export "matmul_i8")
    (param $x i32) (param $q i32) (param $scale i32) (param $y i32) (param $n i32) (param $in i32) (param $out i32)
    (local $o i32) (local $t i32) (local $i i32) (local $xRowBytes i32)
    (local $qrow i32) (local $qp i32) (local $xp i32) (local $yp i32) (local $s f32)
    (local $v v128) (local $lo v128) (local $hi v128)
    (local $a0 v128) (local $a1 v128) (local $a2 v128) (local $a3 v128)
    (local.set $xRowBytes (i32.shl (local.get $in) (i32.const 2)))
    (block $done_o (loop $next_o
      (br_if $done_o (i32.ge_u (local.get $o) (local.get $out)))
      (local.set $qrow (i32.add (local.get $q) (i32.mul (local.get $o) (local.get $in))))
      (local.set $s (f32.load (i32.add (local.get $scale) (i32.shl (local.get $o) (i32.const 2)))))
      (local.set $t (i32.const 0))
      (block $done_t (loop $next_t
        (br_if $done_t (i32.ge_u (local.get $t) (local.get $n)))
        (local.set $qp (local.get $qrow))
        (local.set $xp (i32.add (local.get $x) (i32.mul (local.get $t) (local.get $xRowBytes))))
        (local.set $a0 (v128.const i32x4 0 0 0 0))
        (local.set $a1 (v128.const i32x4 0 0 0 0))
        (local.set $a2 (v128.const i32x4 0 0 0 0))
        (local.set $a3 (v128.const i32x4 0 0 0 0))
        (local.set $i (i32.const 0))
        (block $done_i (loop $next_i
          (br_if $done_i (i32.ge_u (local.get $i) (local.get $in)))
          (local.set $v (v128.load (local.get $qp)))
          (local.set $lo (i16x8.extend_low_i8x16_s (local.get $v)))
          (local.set $hi (i16x8.extend_high_i8x16_s (local.get $v)))
          (local.set $a0 (f32x4.add (local.get $a0)
            (f32x4.mul (f32x4.convert_i32x4_s (i32x4.extend_low_i16x8_s (local.get $lo)))
                       (v128.load (local.get $xp)))))
          (local.set $a1 (f32x4.add (local.get $a1)
            (f32x4.mul (f32x4.convert_i32x4_s (i32x4.extend_high_i16x8_s (local.get $lo)))
                       (v128.load offset=16 (local.get $xp)))))
          (local.set $a2 (f32x4.add (local.get $a2)
            (f32x4.mul (f32x4.convert_i32x4_s (i32x4.extend_low_i16x8_s (local.get $hi)))
                       (v128.load offset=32 (local.get $xp)))))
          (local.set $a3 (f32x4.add (local.get $a3)
            (f32x4.mul (f32x4.convert_i32x4_s (i32x4.extend_high_i16x8_s (local.get $hi)))
                       (v128.load offset=48 (local.get $xp)))))
          (local.set $qp (i32.add (local.get $qp) (i32.const 16)))
          (local.set $xp (i32.add (local.get $xp) (i32.const 64)))
          (local.set $i (i32.add (local.get $i) (i32.const 16)))
          (br $next_i)))
        (local.set $yp (i32.add (local.get $y)
          (i32.shl (i32.add (i32.mul (local.get $t) (local.get $out)) (local.get $o)) (i32.const 2))))
        (f32.store (local.get $yp)
          (f32.mul (local.get $s)
            (call $hsum (f32x4.add (f32x4.add (local.get $a0) (local.get $a1))
                                   (f32x4.add (local.get $a2) (local.get $a3))))))
        (local.set $t (i32.add (local.get $t) (i32.const 1)))
        (br $next_t)))
      (local.set $o (i32.add (local.get $o) (i32.const 1)))
      (br $next_o))))

  ;; (lane0 + lane1) + (lane2 + lane3)
  (func $hsum (param $v v128) (result f32)
    (f32.add
      (f32.add (f32x4.extract_lane 0 (local.get $v)) (f32x4.extract_lane 1 (local.get $v)))
      (f32.add (f32x4.extract_lane 2 (local.get $v)) (f32x4.extract_lane 3 (local.get $v)))))
)
