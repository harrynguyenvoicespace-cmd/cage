# Cage Lab R15

Demo 3D độc lập tại **http://localhost:8877/**. Không sửa dự án BloxLab.

```powershell
cd D:\cage
npm start
```

Không cần cài dependency: Three.js r183 đã được lưu trong `vendor/`. Nếu port 8877 đang chạy, mở URL trực tiếp.

## Cách so sánh

Chọn một trong **9 mẫu áo độc lập**: áo ngắn tay, dài tay, sweater rộng, jacket mở trước, áo dáng dài và 4 hoodie (thường, rộng, trùm đầu, mở khóa). Hoodie có hình học mũ thật; mẫu trùm đầu chừa mặt phía trước. Mỗi mesh được dựng độc lập theo R15, không lấy vertex từ cage. Đổi body gốc/rộng, giơ tay, chạy animation đi bộ rồi tạm dừng. Bật/tắt body, trang phục và hai cage để nhìn hình học.

Đổi mẫu áo dùng liên kết MLS với cùng cage chuẩn 1.358 vertex. Tham số solver và cách pose dùng chung cho mọi mẫu; khác biệt chỉ nằm ở thiết kế mesh, mũ và vùng thân áo. Đây là kiểm tra khả năng thích ứng trên các mesh đã dựng quanh R15, chưa phải tính năng tự fit mọi áo nhập từ bên ngoài.

`Trước fit` hiển thị áo và cage nguồn R15; `Sau fit` dùng cage của body đã chọn, ghép theo UV chuẩn. `Chụp trạng thái` lưu ảnh PNG thật từ canvas WebGL và JSON số đo vào `evidence/`; khi đang đi bộ, thao tác này dừng đúng pose đang xem. `Tải cage đã fit` xuất snapshot JSON, không phải asset Roblox đã được kiểm định.

Bộ chọn **Mannequin** có thêm Classic, Rthro và Rthro Slender từ 5 FBX được cung cấp. Hai file không có cage được đối chiếu với body trong bản có cage. Đây là mannequin, không chứa mesh áo. Cả 9 áo hiện có được chuyển sang body đã chọn bằng cùng liên kết MLS tính từ áo/cage nguồn R15; không dựng lại áo riêng cho từng body. Đường chuyển mannequin mở rộng vùng hỗ trợ từ nguồn để giới hạn hệ số ngoại suy, giữ identity và dùng chung các hệ số đã ổn định trên cả 3 body. Cách này sửa lỗi điểm áo bị kéo vọt xa khi cage nguồn có vùng hỗ trợ gần phẳng. `Trước fit` giữ áo và cage nguồn R15 để so sánh. Thử nghiệm retarget áo Roblox cũ chỉ dùng trên R15 ban đầu.

**Chống xuyên body khi fit** mặc định bật cho mannequin nhập. Sau phép chuyển cage, solver kiểm tra thêm điểm trên các tam giác ở ngực và điều chỉnh control cage theo body ở tư thế đứng. Áo vẫn được tính qua cùng liên kết MLS nguồn; không thêm vertex, sửa UV hoặc che body. Bỏ chọn để so sánh phép chuyển cage chưa sửa tiếp xúc. Nếu kết quả làm đảo hai lớp áo hoặc co mặt quá mức, giữ phép chuyển gốc và báo trên giao diện. Cage FBX ban đầu được giữ riêng trong snapshot `authoredInner`; `inner` là cage thực tế đang hiển thị. Tên ảnh/snapshot phân biệt trạng thái chống xuyên, sửa tiếp xúc sau pose và trước/sau fit.

Importer giữ kích thước tương đối thật của 3 mannequin, xoay 180° quanh Y và đặt bàn chân lên mặt đất. Cage Rthro/Slender có 1.358 vertex; Classic có 1.362 vertex nguồn. UV ghép đủ 1.358 điểm cage chuẩn, không nội suy điểm thiếu. Classic có 4 cặp vertex cùng UV nhưng cách nhau tối đa khoảng 0,0183 stud: cage chuẩn dùng vị trí trung bình và lưu cage nguồn nguyên vẹn trong `assets/mannequins/`. Cả 5 FBX đều là mesh tĩnh, không có skin cluster hoặc skeleton; khớp dùng để giơ tay/đi bộ được suy ra từ đường nối cage từng bộ phận và ghi rõ trong provenance. Chuyển động này là mô phỏng, chưa kiểm chứng với rig/animation Roblox thực tế.

`Sửa tiếp xúc · thử nghiệm` mặc định tắt, chỉ dùng khi dừng pose. Solver điều chỉnh các control cage bằng constraint tiếp xúc, rồi tính lại áo qua MLS; không sửa trực tiếp vertex áo. Nó có thể giảm xuyên nhưng cũng làm tăng strain, nên kết quả gốc vẫn được giữ để so sánh.

## Dữ liệu và thuật toán

- R15 thật từ `D:/bloxlab/frontend/public/assets/skin-examples/r15-rig.json`, giữ nguyên binary trong `assets/r15.glb`.
- Cage chuẩn Roblox trong `assets/roblox-cage.json`: 1.358 vertex, UV và indices được giữ nguyên.
- [BlockyCharacter.fbx chính thức](https://prod.docsiteassets.roblox.com/assets/avatar/dynamic-heads/reference-files/BlockyCharacter.fbx) được ghép qua UV vào topology chuẩn: 1.343 điểm khớp trực tiếp; 15 điểm head dùng MLS từ các điểm lân cận. Xoay 180° quanh Y để khớp hướng R15, không phản chiếu winding. `assets/blocky-cage-target.json` ghi đầy đủ provenance.
- Cùng một binder MLS, cơ chế làm mượt theo khoảng cách thật và tham số cho cả chín kiểu áo. R15 joint thật điều khiển cage; áo chỉ biến dạng từ tọa độ cage. Outer cage nhận field chuyển động của trang phục. Phần mũ trùm đầu có vùng `Head`; mũ hạ theo thân trên.
- Mesh và tham số hình dáng nằm trong `assets/garment-variants.json`. Áo Roblox retarget cũ giữ như một thử nghiệm riêng.

Đây là implementation độc lập để nghiên cứu cage, không tái hiện chính xác solver WrapLayer nội bộ của Roblox. Số đo `Xuyên body` dùng toàn bộ body, gồm vertex, giữa cạnh và tâm tam giác. `Ngoài outer cage` dùng generalized winding và tolerance 0,003 stud; vùng winding chồng được báo riêng, không che bằng ray parity.

## Kiểm tra và tái tạo

```powershell
npm test
npm run test:mannequins
npm run test:contacts
npm run verify -- --all-variants
npm run build:variants
node tools/prepare-blocky.mjs
```

`npm test` kiểm tra toán, dependency cage thật, source provenance, cấu trúc mesh áo và các biến dạng cage đại diện. Ma trận độc lập kiểm tra toàn bộ catalog **9 áo × 10 trạng thái**, với cùng body, seed và algorithm options; ghi `evidence/independent-all-variants-check.json` cùng hash của code và dữ liệu. Có thể dùng `--jobs=3` để chạy audit trên máy đủ tài nguyên; mặc định 2 tiến trình. `auditIntegrityPassed` xác nhận đúng mẫu, đủ trạng thái, dữ liệu ổn định và hình học hữu hạn; `geometryPassed` báo riêng việc còn xuyên body, thiếu bao phủ hoặc tam giác suy biến/collapse. Exit code 0 không đồng nghĩa mọi pose đều fit hoàn hảo.

`npm run build:variants` tái tạo 5 mesh mới và provenance bằng factory chung; giữ nguyên 4 mesh tham chiếu ban đầu để so sánh. Asset regeneration từ FBX vẫn cần các file nguồn gốc được mô tả trong script, không cần chạy để mở demo.

`tools/import-mannequins.mjs` đọc 5 FBX nguồn để tái tạo các asset mannequin. Catalog `assets/mannequins/catalog.json` ghi hash nguồn, phép chuẩn hóa, đối chiếu body và kiểm tra UV/topology. `npm run test:mannequins` kiểm tra cả 9 áo trên 3 body và các tư thế hoodie đại diện với sửa tiếp xúc tắt; báo tính toàn vẹn dữ liệu riêng với chất lượng phép chuyển cage trong `evidence/mannequin-check.json`. `npm run test:contacts` kiểm tra 12 fit hoodie với sửa tiếp xúc bật, bao gồm fallback, cage nguồn, liên kết MLS dùng chung, shell và kiểm tra ngực độc lập; ghi `evidence/mannequin-contact-check.json`. Cả hai suite nằm trong `npm test`. Đổi mẫu áo hoặc pose vẫn có thể gây xuyên body hay làm mũ thiếu bao phủ.

Trên R15 ban đầu, các mẫu đứng đều không xuyên body trong các điểm được kiểm tra; chuyển động đi bộ/khuỷu tay vẫn còn lỗi. Trong ma trận 90 trạng thái hiện tại, 40 trạng thái hoodie đều giữ đúng số vertex cage và hình học hữu hạn, nhưng 13 trạng thái có mẫu xuyên body và phần mũ chưa được outer cage bao hết. Mức xuyên body lớn nhất trong nhóm hoodie là 0,371% mẫu kiểm tra; tối đa 5,644% vertex áo nằm ngoài outer cage. Có 4 trạng thái hoodie xuất hiện tam giác co dưới 1% diện tích gốc. Đây là giới hạn được đo, không phải kết quả fit hoàn hảo.

Audit phép chuyển cage 3 mannequin FBX kiểm tra **27 fit đứng + 36 trạng thái hoodie**, chưa bật sửa tiếp xúc. Hash cả 5 FBX, dữ liệu và code giữ nguyên; mỗi áo dùng cùng hash hệ số nguồn trên cả 3 target. Lỗi kéo vọt lớn xuất hiện trong 22/27 phép chuyển cũ ở tư thế đứng và không còn trong 63 trạng thái sau ổn định. Kiểm tra kết hợp độ giãn cạnh và mức tăng chiều dài tuyệt đối để phân biệt lỗi kéo vọt với cạnh cổ áo rất ngắn bị méo. Có 57/63 trạng thái còn điểm kiểm tra xuyên body, 27 trạng thái thiếu bao phủ outer cage và 35 trạng thái có tam giác co dưới 1% diện tích nguồn. Độ xuyên tối đa 0,271 stud; khoảng cách ngoài cage tối đa được lấy mẫu 0,338 stud. Kiểm tra pose dùng mọi vertex và một số tam giác; kiểm tra outer lấy mẫu 256 vertex mỗi trạng thái, nên không chứng nhận toàn bộ bề mặt. Ray parity trên mesh Head mở cũng có thể báo xuyên sai.

Trong audit tiếp xúc mới, cả 3 hoodie trùm đầu ở tư thế đứng giảm **285 điểm xuyên body xuống 0**, và **170 điểm ngực bị lộ xuống 0** trên lưới độc lập với solver. Body kín dùng ba ray và chặn ngoài bounding box; Head mở dùng generalized winding, báo riêng vùng không chắc chắn. Lưới ngực 29 × 23 nằm dưới vùng cổ áo, không ép đóng cổ hoặc mặt mũ. Hai lớp áo, component volume và topology được giữ; không có cạnh kéo vọt hoặc tam giác diện tích bằng 0 trong 12 fit hoodie. Ba kiểu/body khác bị từ chối sửa vì chất lượng shell giảm và tiếp tục dùng kết quả gốc. Các phép lấy mẫu không chứng minh toàn bộ bề mặt luôn tách rời; thay đổi độ rộng, giơ tay và đi bộ vẫn có thể xuyên. Đây là sửa lỗi ngực ở trạng thái đứng, chưa phải fit hoàn hảo cho mọi áo/pose.

Mũ hạ nhô xa ra sau thân hơn giới hạn mở rộng 0,60 stud của outer fitter chung; mũ trùm đầu còn thiếu bao phủ ở một số góc. Mesh áo, tay, túi và dây rút ở tư thế đứng vẫn nằm trong outer cage ở hai mẫu hoodie thường/trùm đầu đã đối chiếu theo component. Cage còn các vùng chồng và chưa được kiểm tra bằng validator Roblox Studio. Không coi snapshot JSON là UGC sẵn sàng xuất bản.

Nguồn đầy đủ: `assets/sources.json`, `assets/source/README.md`. Tham khảo [Roblox caging](https://create.roblox.com/docs/avatar/layered-accessories/caging-best-practices), [Blender Shrinkwrap](https://docs.blender.org/manual/en/latest/modeling/modifiers/deform/shrinkwrap.html), [cage deformation reference](https://github.com/Junyu-Liu-Nate/Shape-Deformation-with-Cages). Third-party notices trong `vendor/THIRD-PARTY-NOTICES.txt`.
