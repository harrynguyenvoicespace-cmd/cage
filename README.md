# Cage Lab R15

Demo 3D độc lập tại **http://localhost:8877/**. Không sửa dự án BloxLab.

```powershell
cd D:\cage
npm start
```

Không cần cài dependency: Three.js r183 đã được lưu trong `vendor/`. Nếu port 8877 đang chạy, mở URL trực tiếp.

## Cách so sánh

Chọn áo ngắn tay, dài tay, sweater rộng hoặc jacket mở trước. Mỗi mesh được dựng độc lập theo R15, không lấy vertex từ cage. Đổi body gốc/rộng, giơ tay, chạy animation đi bộ rồi tạm dừng. Bật/tắt body, trang phục và hai cage để nhìn hình học.

`Trước fit` hiển thị cage chuẩn ban đầu; `Sau fit` dùng cage blocky ghép qua UV. `Chụp trạng thái` lưu ảnh PNG thật từ canvas WebGL và JSON số đo vào `evidence/`; khi đang đi bộ, thao tác này dừng đúng pose đang xem. `Tải cage đã fit` xuất snapshot JSON, không phải asset Roblox đã được kiểm định.

`Sửa tiếp xúc · thử nghiệm` mặc định tắt, chỉ dùng khi dừng pose. Solver điều chỉnh các control cage bằng constraint tiếp xúc, rồi tính lại áo qua MLS; không sửa trực tiếp vertex áo. Nó có thể giảm xuyên nhưng cũng làm tăng strain, nên kết quả gốc vẫn được giữ để so sánh.

## Dữ liệu và thuật toán

- R15 thật từ `D:/bloxlab/frontend/public/assets/skin-examples/r15-rig.json`, giữ nguyên binary trong `assets/r15.glb`.
- Cage chuẩn Roblox trong `assets/roblox-cage.json`: 1.358 vertex, UV và indices được giữ nguyên.
- [BlockyCharacter.fbx chính thức](https://prod.docsiteassets.roblox.com/assets/avatar/dynamic-heads/reference-files/BlockyCharacter.fbx) được ghép qua UV vào topology chuẩn: 1.343 điểm khớp trực tiếp; 15 điểm head dùng MLS từ các điểm lân cận. Xoay 180° quanh Y để khớp hướng R15, không phản chiếu winding. `assets/blocky-cage-target.json` ghi đầy đủ provenance.
- Cùng một binder MLS, cơ chế làm mượt theo khoảng cách thật và tham số cho cả bốn kiểu áo. R15 joint thật điều khiển cage; áo chỉ biến dạng từ tọa độ cage. Outer cage nhận field chuyển động của trang phục.
- Mesh và tham số hình dáng nằm trong `assets/garment-variants.json`. Áo Roblox retarget cũ giữ như một thử nghiệm riêng.

Đây là implementation độc lập để nghiên cứu cage, không tái hiện chính xác solver WrapLayer nội bộ của Roblox. Số đo `Xuyên body` dùng toàn bộ body, gồm vertex, giữa cạnh và tâm tam giác. `Ngoài outer cage` dùng generalized winding và tolerance 0,003 stud; vùng winding chồng được báo riêng, không che bằng ray parity.

## Kiểm tra và tái tạo

```powershell
npm test
npm run verify -- --all-variants
node tools/prepare-blocky.mjs
node tools/build-variants.mjs
```

`npm test` kiểm tra toán, dependency cage thật, source provenance và geometry. Ma trận độc lập kiểm tra 4 áo × 10 trạng thái với cùng body, seed và algorithm options; ghi `evidence/independent-all-variants-check.json` cùng hash của code và dữ liệu.

Các mẫu đứng đều không xuyên body; chuyển động đi bộ/khuỷu tay còn lỗi nhỏ. Cage còn các vùng chồng và chưa được kiểm tra bằng validator Roblox Studio. Không coi snapshot JSON là UGC sẵn sàng xuất bản.

Nguồn đầy đủ: `assets/sources.json`, `assets/source/README.md`. Tham khảo [Roblox caging](https://create.roblox.com/docs/avatar/layered-accessories/caging-best-practices), [Blender Shrinkwrap](https://docs.blender.org/manual/en/latest/modeling/modifiers/deform/shrinkwrap.html), [cage deformation reference](https://github.com/Junyu-Liu-Nate/Shape-Deformation-with-Cages). Third-party notices trong `vendor/THIRD-PARTY-NOTICES.txt`.
