# 方針（のはずだった）
```bash
llama-quantize \
  model-BF16.gguf \
  model-ROCMFP2.gguf \
  Q2_0_ROCMFPX
```

これで簡単に量子化できる  
あとはもう既にあるフルサイズのDS4 FlashをROCmFP2量子化するときみたいに、混合ROCmFPX量子化で精度もいい感じに保つ


# 問題発生
- K160がすでにMXFP4だった
  - 現行converterはこれをBF16に戻さないで、そのまま扱う方針
- 一応手立てはある
  - 量子化されてるテンソルでも、F32へdequantizeした後にまた量子化することはできる
  - デフォルトでは無効化されてるだけ
- 技術的にはできる
  - しかし、品質的に大丈夫かは別問題
  - 現行ROCmFPXがDS4の一番デカい部分＝MXFP4のrouted expertsをROCmFP2化しないのが問題


# 結論
- 個人的に Laguna S 2.1 でROCmFPXを使ってるあたり、ツールコールが全く安定しない
- FOCmFPXの推論エンジンを更新してもダメ
- だから、捨てました



ChatGPTセッションログ（非公開、メモ）: https://chatgpt.com/g/g-p-6a742d6c2ff48191a6b9b350a6be0f71/c/6a7857b8-d628-83ee-8eb3-dd8b170c30ac
